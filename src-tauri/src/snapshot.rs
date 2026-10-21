use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use flate2::{read::GzDecoder, write::GzEncoder, Compression};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::OnceLock;
use std::time::{SystemTime, UNIX_EPOCH};

const SNAPSHOT_MAGIC: &[u8; 16] = b"LINKASSIST-SNP01";
const SNAPSHOT_FORMAT_VERSION: u32 = 1;
const FOOTER_LEN: u64 = SNAPSHOT_MAGIC.len() as u64 + 8 + 32;
const MAX_RESOURCE_FILES: usize = 10_000;
const MAX_RESOURCE_BYTES: u64 = 256 * 1024 * 1024;
const MAX_DECODED_PAYLOAD_BYTES: u64 = 384 * 1024 * 1024;

static SNAPSHOT_RUNTIME: OnceLock<Result<Option<SnapshotRuntime>, String>> = OnceLock::new();

#[derive(Debug, Clone)]
pub struct SnapshotRuntime {
    pub id: String,
    pub config_path: PathBuf,
    aliases: Vec<RuntimeAlias>,
}

#[derive(Debug, Clone)]
struct RuntimeAlias {
    source_keys: Vec<String>,
    bundled_root: PathBuf,
    is_dir: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotPayload {
    format_version: u32,
    product: String,
    product_version: String,
    created_at: u64,
    config: Value,
    aliases: Vec<PathAlias>,
    files: Vec<SnapshotFile>,
    #[serde(default)]
    warnings: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathAlias {
    source_path: String,
    references: Vec<String>,
    bundled_path: String,
    is_dir: bool,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotFile {
    bundled_path: String,
    content_base64: String,
}

#[derive(Debug)]
struct EmbeddedPayload {
    base_executable_len: u64,
    digest: [u8; 32],
    payload: SnapshotPayload,
}

#[derive(Debug)]
pub struct SnapshotReport {
    pub output: PathBuf,
    pub resource_files: usize,
    pub resource_bytes: u64,
    pub snapshot_id: String,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ReferenceKind {
    File,
    Directory,
}

#[derive(Debug)]
struct ResourceCollector {
    aliases: Vec<PathAlias>,
    alias_by_source: HashMap<(String, bool), usize>,
    files: BTreeMap<String, Vec<u8>>,
    total_bytes: u64,
    warnings: Vec<String>,
}

impl ResourceCollector {
    fn new() -> Self {
        Self {
            aliases: Vec::new(),
            alias_by_source: HashMap::new(),
            files: BTreeMap::new(),
            total_bytes: 0,
            warnings: Vec::new(),
        }
    }

    fn add_loaded_reference(
        &mut self,
        raw_path: &str,
        kind: ReferenceKind,
        base_file: Option<&Path>,
        purpose: &str,
    ) -> Result<PathBuf, String> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(format!("{purpose} path is empty"));
        }
        if trimmed.contains("${") {
            return Err(format!(
                "{purpose} uses a dynamic path that cannot be snapshotted: {trimmed}"
            ));
        }
        let candidate = resolve_reference_path(trimmed, base_file)?;
        match fs::symlink_metadata(&candidate) {
            Ok(_) => self.add_reference(raw_path, kind, base_file, purpose),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                if let Some(relocated) = find_relocated_config_resource(&candidate) {
                    let relocated_text = relocated.to_string_lossy().into_owned();
                    let canonical =
                        self.add_reference(&relocated_text, kind, base_file, purpose)?;
                    let alias_key = (
                        normalized_path_key(&canonical),
                        kind == ReferenceKind::Directory,
                    );
                    if let Some(index) = self.alias_by_source.get(&alias_key).copied() {
                        let alias = &mut self.aliases[index];
                        if !alias.references.iter().any(|value| value == trimmed) {
                            alias.references.push(trimmed.to_string());
                        }
                    }
                    self.push_warning(format!(
                        "Relocated missing {purpose} '{}' to '{}'",
                        candidate.display(),
                        canonical.display()
                    ));
                    return Ok(canonical);
                }
                Err(format!(
                    "Cannot package missing {purpose}: {}",
                    candidate.display()
                ))
            }
            Err(error) => Err(format!(
                "Cannot read {purpose} '{}': {error}",
                candidate.display()
            )),
        }
    }

    fn push_warning(&mut self, warning: String) {
        if !self.warnings.contains(&warning) {
            self.warnings.push(warning);
        }
    }

    fn add_reference(
        &mut self,
        raw_path: &str,
        kind: ReferenceKind,
        base_file: Option<&Path>,
        purpose: &str,
    ) -> Result<PathBuf, String> {
        let trimmed = raw_path.trim();
        if trimmed.is_empty() {
            return Err(format!("{purpose} path is empty"));
        }
        if trimmed.contains("${") {
            return Err(format!(
                "{purpose} uses a dynamic path that cannot be snapshotted: {trimmed}"
            ));
        }

        let candidate = resolve_reference_path(trimmed, base_file)?;
        let metadata = fs::symlink_metadata(&candidate)
            .map_err(|error| format!("Cannot read {purpose} '{}': {error}", candidate.display()))?;
        if metadata.file_type().is_symlink() {
            return Err(format!(
                "{purpose} must not be a symbolic link or junction: {}",
                candidate.display()
            ));
        }
        match kind {
            ReferenceKind::File if !metadata.is_file() => {
                return Err(format!("{purpose} is not a file: {}", candidate.display()));
            }
            ReferenceKind::Directory if !metadata.is_dir() => {
                return Err(format!(
                    "{purpose} is not a directory: {}",
                    candidate.display()
                ));
            }
            _ => {}
        }

        let canonical = fs::canonicalize(&candidate).map_err(|error| {
            format!(
                "Cannot resolve {purpose} '{}': {error}",
                candidate.display()
            )
        })?;
        let source_key = normalized_path_key(&canonical);
        let alias_key = (source_key.clone(), kind == ReferenceKind::Directory);
        if let Some(index) = self.alias_by_source.get(&alias_key).copied() {
            let alias = &mut self.aliases[index];
            if !alias.references.iter().any(|value| value == trimmed) {
                alias.references.push(trimmed.to_string());
            }
            return Ok(canonical);
        }

        let alias_index = self.aliases.len();
        let leaf = safe_leaf_name(&canonical);
        // Keep file basenames intact. Some script types intentionally use their filename as an
        // additional validation boundary (for example `canvas-lifecycle-*.lua`), so prefixing the
        // file itself would make an otherwise valid bundled script unusable. The per-alias
        // directory still guarantees uniqueness when different resources share the same leaf.
        let bundled_path = match kind {
            ReferenceKind::File => format!("resources/{alias_index:04}/{leaf}"),
            ReferenceKind::Directory => format!("resources/{alias_index:04}-{leaf}"),
        };
        let alias = PathAlias {
            source_path: canonical.to_string_lossy().into_owned(),
            references: vec![trimmed.to_string()],
            bundled_path: bundled_path.clone(),
            is_dir: kind == ReferenceKind::Directory,
        };
        self.alias_by_source.insert(alias_key, alias_index);
        self.aliases.push(alias);

        match kind {
            ReferenceKind::File => self.add_file(&canonical, &bundled_path)?,
            ReferenceKind::Directory => self.add_directory(&canonical, &bundled_path)?,
        }
        Ok(canonical)
    }

    fn add_directory(&mut self, root: &Path, bundled_root: &str) -> Result<(), String> {
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            let entries = fs::read_dir(&directory).map_err(|error| {
                format!(
                    "Cannot enumerate snapshot resource '{}': {error}",
                    directory.display()
                )
            })?;
            for entry in entries {
                let entry = entry.map_err(|error| {
                    format!(
                        "Cannot enumerate snapshot resource '{}': {error}",
                        directory.display()
                    )
                })?;
                let path = entry.path();
                let metadata = fs::symlink_metadata(&path).map_err(|error| {
                    format!(
                        "Cannot inspect snapshot resource '{}': {error}",
                        path.display()
                    )
                })?;
                if metadata.file_type().is_symlink() {
                    return Err(format!(
                        "Snapshot resource directories must not contain symbolic links or junctions: {}",
                        path.display()
                    ));
                }
                if metadata.is_dir() {
                    pending.push(path);
                } else if metadata.is_file() {
                    let canonical = fs::canonicalize(&path).map_err(|error| {
                        format!(
                            "Cannot resolve snapshot resource '{}': {error}",
                            path.display()
                        )
                    })?;
                    if !canonical.starts_with(root) {
                        return Err(format!(
                            "Snapshot resource escapes its declared root: {}",
                            path.display()
                        ));
                    }
                    let relative = canonical.strip_prefix(root).map_err(|_| {
                        format!("Cannot make snapshot resource relative: {}", path.display())
                    })?;
                    let bundled = join_bundle_path(bundled_root, relative)?;
                    self.add_file(&canonical, &bundled)?;
                }
            }
        }
        Ok(())
    }

    fn add_file(&mut self, source: &Path, bundled_path: &str) -> Result<(), String> {
        if self.files.contains_key(bundled_path) {
            return Ok(());
        }
        if self.files.len() >= MAX_RESOURCE_FILES {
            return Err(format!(
                "Snapshot contains more than {MAX_RESOURCE_FILES} resource files"
            ));
        }
        let bytes = fs::read(source).map_err(|error| {
            format!(
                "Cannot read snapshot resource '{}': {error}",
                source.display()
            )
        })?;
        let next_total = self.total_bytes.saturating_add(bytes.len() as u64);
        if next_total > MAX_RESOURCE_BYTES {
            return Err(format!(
                "Snapshot resources exceed the {} MiB limit while adding '{}'",
                MAX_RESOURCE_BYTES / 1024 / 1024,
                source.display()
            ));
        }
        self.total_bytes = next_total;
        self.files.insert(bundled_path.to_string(), bytes);
        Ok(())
    }
}

pub fn create_snapshot(output: &Path, mut config: Value) -> Result<SnapshotReport, String> {
    let source_exe = std::env::current_exe()
        .map_err(|error| format!("Cannot locate the LinkAssist executable: {error}"))?;
    let output = normalize_output_path(output)?;
    if output.exists() {
        return Err(format!(
            "Refusing to overwrite existing file: {}",
            output.display()
        ));
    }
    if same_path(&source_exe, &output) {
        return Err("Snapshot output must differ from the running executable".to_string());
    }

    sanitize_snapshot_config(&mut config);
    let mut collector = ResourceCollector::new();
    let mut automation_scripts = Vec::new();
    collect_config_resources(&config, &mut collector, &mut automation_scripts)?;
    collect_automation_dependencies(&mut collector, automation_scripts)?;

    let files = collector
        .files
        .iter()
        .map(|(bundled_path, content)| SnapshotFile {
            bundled_path: bundled_path.clone(),
            content_base64: BASE64.encode(content),
        })
        .collect::<Vec<_>>();
    let payload = SnapshotPayload {
        format_version: SNAPSHOT_FORMAT_VERSION,
        product: "LinkAssist".to_string(),
        product_version: env!("CARGO_PKG_VERSION").to_string(),
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        config,
        aliases: collector.aliases,
        files,
        warnings: collector.warnings.clone(),
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|error| format!("Cannot serialize snapshot payload: {error}"))?;
    let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
    encoder
        .write_all(&json)
        .map_err(|error| format!("Cannot compress snapshot payload: {error}"))?;
    let compressed = encoder
        .finish()
        .map_err(|error| format!("Cannot finish snapshot compression: {error}"))?;
    let digest: [u8; 32] = Sha256::digest(&compressed).into();
    let snapshot_id = hex::encode(digest);

    let base_len = embedded_payload_from_path(&source_exe)?
        .map(|embedded| embedded.base_executable_len)
        .unwrap_or_else(|| {
            fs::metadata(&source_exe)
                .map(|meta| meta.len())
                .unwrap_or(0)
        });
    if base_len == 0 {
        return Err("The running executable is empty or unreadable".to_string());
    }
    write_snapshot_executable(&source_exe, base_len, &output, &compressed, &digest)?;

    Ok(SnapshotReport {
        output,
        resource_files: payload.files.len(),
        resource_bytes: collector.total_bytes,
        snapshot_id,
        warnings: collector.warnings,
    })
}

pub fn runtime() -> Result<Option<&'static SnapshotRuntime>, String> {
    match SNAPSHOT_RUNTIME.get_or_init(initialize_runtime) {
        Ok(Some(runtime)) => Ok(Some(runtime)),
        Ok(None) => Ok(None),
        Err(error) => Err(error.clone()),
    }
}

pub fn runtime_config_path() -> Result<Option<PathBuf>, String> {
    Ok(runtime()?.map(|runtime| runtime.config_path.clone()))
}

pub fn prepare_runtime() -> Result<(), String> {
    runtime().map(|_| ())
}

pub fn instance_key() -> Option<String> {
    runtime().ok().flatten().map(|runtime| runtime.id.clone())
}

pub fn resolve_path(path: &str) -> String {
    resolve_path_with_base(path, None)
}

pub fn resolve_path_with_base(path: &str, base_file: Option<&str>) -> String {
    let Ok(Some(runtime)) = runtime() else {
        return path.to_string();
    };

    if let Some(mapped) = map_runtime_path(runtime, path) {
        return mapped.to_string_lossy().into_owned();
    }

    if Path::new(path).is_relative() {
        if let Some(base_file) = base_file {
            if let Some(original_base) = reverse_runtime_path(runtime, base_file) {
                if let Some(parent) = original_base.parent() {
                    let original_candidate = lexical_normalize(&parent.join(path));
                    if let Some(mapped) =
                        map_runtime_path(runtime, &original_candidate.to_string_lossy())
                    {
                        return mapped.to_string_lossy().into_owned();
                    }
                }
            }
        }
    }

    path.to_string()
}

fn initialize_runtime() -> Result<Option<SnapshotRuntime>, String> {
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate the LinkAssist executable: {error}"))?;
    let Some(embedded) = embedded_payload_from_path(&executable)? else {
        return Ok(None);
    };
    if embedded.payload.format_version != SNAPSHOT_FORMAT_VERSION {
        return Err(format!(
            "Unsupported LinkAssist snapshot format {}",
            embedded.payload.format_version
        ));
    }

    let id = hex::encode(embedded.digest);
    let root = snapshot_base_directory().join(&id);
    let resources_root = root.join("payload");
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Cannot create snapshot directory '{}': {error}",
            root.display()
        )
    })?;

    let marker_path = root.join("payload.sha256");
    let marker_matches = fs::read_to_string(&marker_path)
        .map(|value| value.trim() == id)
        .unwrap_or(false);
    if !marker_matches {
        if resources_root.exists() {
            fs::remove_dir_all(&resources_root).map_err(|error| {
                format!(
                    "Cannot replace incomplete snapshot resources '{}': {error}",
                    resources_root.display()
                )
            })?;
        }
        fs::create_dir_all(&resources_root).map_err(|error| {
            format!(
                "Cannot create snapshot resources '{}': {error}",
                resources_root.display()
            )
        })?;
        for file in &embedded.payload.files {
            let relative = validate_bundle_path(&file.bundled_path)?;
            let destination = resources_root.join(relative);
            if let Some(parent) = destination.parent() {
                fs::create_dir_all(parent).map_err(|error| {
                    format!(
                        "Cannot create snapshot resource directory '{}': {error}",
                        parent.display()
                    )
                })?;
            }
            let content = BASE64.decode(&file.content_base64).map_err(|error| {
                format!(
                    "Snapshot resource '{}' is corrupt: {error}",
                    file.bundled_path
                )
            })?;
            fs::write(&destination, content).map_err(|error| {
                format!(
                    "Cannot extract snapshot resource '{}': {error}",
                    destination.display()
                )
            })?;
        }
        for alias in &embedded.payload.aliases {
            if alias.is_dir {
                let relative = validate_bundle_path(&alias.bundled_path)?;
                fs::create_dir_all(resources_root.join(relative)).map_err(|error| {
                    format!("Cannot create snapshot resource directory: {error}")
                })?;
            }
        }
        fs::write(&marker_path, &id).map_err(|error| {
            format!(
                "Cannot finalize snapshot resources '{}': {error}",
                marker_path.display()
            )
        })?;
    }

    let aliases = build_runtime_aliases(&embedded.payload.aliases, &resources_root)?;
    let config_path = root.join("config.json");
    if !config_path.exists() {
        let mut config = embedded.payload.config;
        rewrite_config_paths(&mut config, &aliases);
        let json = serde_json::to_vec_pretty(&config)
            .map_err(|error| format!("Cannot serialize snapshot configuration: {error}"))?;
        fs::write(&config_path, json).map_err(|error| {
            format!(
                "Cannot initialize snapshot configuration '{}': {error}",
                config_path.display()
            )
        })?;
    }

    Ok(Some(SnapshotRuntime {
        id,
        config_path,
        aliases,
    }))
}

fn embedded_payload_from_path(path: &Path) -> Result<Option<EmbeddedPayload>, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("Cannot open executable '{}': {error}", path.display()))?;
    let len = file
        .metadata()
        .map_err(|error| format!("Cannot inspect executable '{}': {error}", path.display()))?
        .len();
    if len < FOOTER_LEN {
        return Ok(None);
    }
    file.seek(SeekFrom::End(-(FOOTER_LEN as i64)))
        .map_err(|error| format!("Cannot inspect snapshot footer: {error}"))?;
    let mut magic = [0_u8; 16];
    file.read_exact(&mut magic)
        .map_err(|error| format!("Cannot read snapshot footer: {error}"))?;
    if &magic != SNAPSHOT_MAGIC {
        return Ok(None);
    }
    let mut length_bytes = [0_u8; 8];
    file.read_exact(&mut length_bytes)
        .map_err(|error| format!("Cannot read snapshot length: {error}"))?;
    let payload_len = u64::from_le_bytes(length_bytes);
    let mut digest = [0_u8; 32];
    file.read_exact(&mut digest)
        .map_err(|error| format!("Cannot read snapshot digest: {error}"))?;
    let base_executable_len = len
        .checked_sub(FOOTER_LEN)
        .and_then(|value| value.checked_sub(payload_len))
        .ok_or_else(|| "Snapshot footer contains an invalid payload length".to_string())?;
    let payload_len_usize = usize::try_from(payload_len)
        .map_err(|_| "Snapshot payload is too large for this platform".to_string())?;
    file.seek(SeekFrom::Start(base_executable_len))
        .map_err(|error| format!("Cannot seek to snapshot payload: {error}"))?;
    let mut compressed = vec![0_u8; payload_len_usize];
    file.read_exact(&mut compressed)
        .map_err(|error| format!("Cannot read snapshot payload: {error}"))?;
    let actual: [u8; 32] = Sha256::digest(&compressed).into();
    if actual != digest {
        return Err("Snapshot payload digest mismatch; the executable is damaged".to_string());
    }

    let mut decoder = GzDecoder::new(compressed.as_slice());
    let mut decoded = Vec::new();
    decoder
        .by_ref()
        .take(MAX_DECODED_PAYLOAD_BYTES + 1)
        .read_to_end(&mut decoded)
        .map_err(|error| format!("Cannot decompress snapshot payload: {error}"))?;
    if decoded.len() as u64 > MAX_DECODED_PAYLOAD_BYTES {
        return Err("Snapshot payload exceeds the decompression safety limit".to_string());
    }
    let payload = serde_json::from_slice(&decoded)
        .map_err(|error| format!("Cannot decode snapshot payload: {error}"))?;
    Ok(Some(EmbeddedPayload {
        base_executable_len,
        digest,
        payload,
    }))
}

fn write_snapshot_executable(
    source: &Path,
    base_len: u64,
    output: &Path,
    payload: &[u8],
    digest: &[u8; 32],
) -> Result<(), String> {
    let parent = output
        .parent()
        .ok_or_else(|| "Snapshot output has no parent directory".to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "Snapshot output directory does not exist: {}",
            parent.display()
        ));
    }
    let temp = parent.join(format!(
        ".{}.snapshot-{}.tmp",
        output
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("linkassist"),
        std::process::id()
    ));
    if temp.exists() {
        fs::remove_file(&temp).map_err(|error| {
            format!(
                "Cannot remove stale snapshot temporary file '{}': {error}",
                temp.display()
            )
        })?;
    }

    let result = (|| -> Result<(), String> {
        let mut input = File::open(source).map_err(|error| {
            format!(
                "Cannot open source executable '{}': {error}",
                source.display()
            )
        })?;
        let mut output_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| format!("Cannot create snapshot '{}': {error}", temp.display()))?;
        std::io::copy(
            &mut std::io::Read::by_ref(&mut input).take(base_len),
            &mut output_file,
        )
        .map_err(|error| format!("Cannot copy LinkAssist executable: {error}"))?;
        output_file
            .write_all(payload)
            .and_then(|_| output_file.write_all(SNAPSHOT_MAGIC))
            .and_then(|_| output_file.write_all(&(payload.len() as u64).to_le_bytes()))
            .and_then(|_| output_file.write_all(digest))
            .and_then(|_| output_file.flush())
            .map_err(|error| format!("Cannot write snapshot payload: {error}"))?;
        output_file
            .sync_all()
            .map_err(|error| format!("Cannot flush snapshot executable: {error}"))?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp);
        return Err(error);
    }
    fs::rename(&temp, output).map_err(|error| {
        let _ = fs::remove_file(&temp);
        format!("Cannot finalize snapshot '{}': {error}", output.display())
    })
}

fn collect_config_resources(
    config: &Value,
    collector: &mut ResourceCollector,
    automation_scripts: &mut Vec<PathBuf>,
) -> Result<(), String> {
    match config {
        Value::Object(object) => {
            if let Some(Value::String(path)) = object.get("protocolResourceRoot") {
                if !path.trim().is_empty() {
                    collector.add_reference(
                        path,
                        ReferenceKind::Directory,
                        None,
                        "protocol resource root",
                    )?;
                }
            }
            if let Some(Value::String(path)) = object.get("protocolFile") {
                if !path.trim().is_empty() {
                    let canonical = collector.add_reference(
                        path,
                        ReferenceKind::File,
                        None,
                        "protocol script",
                    )?;
                    let content = fs::read_to_string(&canonical).map_err(|error| {
                        format!(
                            "Cannot inspect protocol script '{}': {error}",
                            canonical.display()
                        )
                    })?;
                    let has_root = object
                        .get("protocolResourceRoot")
                        .and_then(Value::as_str)
                        .is_some_and(|value| !value.trim().is_empty());
                    if content.contains("read_text_file") && !has_root {
                        return Err(format!(
                            "Protocol script '{}' uses read_text_file but has no explicit protocolResourceRoot",
                            canonical.display()
                        ));
                    }
                }
            }
            for key in ["luaPath", "yamlPath"] {
                if let Some(Value::String(path)) = object.get(key) {
                    if !path.trim().is_empty() {
                        let canonical = collector.add_loaded_reference(
                            path,
                            ReferenceKind::File,
                            None,
                            "loaded script",
                        )?;
                        automation_scripts.push(canonical);
                    }
                }
            }
            for value in object.values() {
                collect_config_resources(value, collector, automation_scripts)?;
            }
        }
        Value::Array(values) => {
            for value in values {
                collect_config_resources(value, collector, automation_scripts)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn collect_automation_dependencies(
    collector: &mut ResourceCollector,
    scripts: Vec<PathBuf>,
) -> Result<(), String> {
    let mut pending = VecDeque::from(scripts);
    let mut visited = HashSet::new();
    while let Some(script_path) = pending.pop_front() {
        let key = normalized_path_key(&script_path);
        if !visited.insert(key) {
            continue;
        }
        let content = fs::read_to_string(&script_path).map_err(|error| {
            format!(
                "Cannot inspect loaded script '{}': {error}",
                script_path.display()
            )
        })?;
        let is_automation = crate::script_markers::ensure_lua_script_kind(
            &content,
            crate::script_markers::LuaScriptKind::Script,
        )
        .is_ok();
        let is_lifecycle = crate::script_markers::ensure_lua_script_kind(
            &content,
            crate::script_markers::LuaScriptKind::CanvasLifecycle,
        )
        .is_ok();
        let document = if is_automation {
            crate::commands::script::parse_lua_script_document(&content)
        } else if is_lifecycle {
            crate::commands::script::parse_lua_canvas_lifecycle_document(&content)
        } else {
            continue;
        }
        .map_err(|error| {
            format!(
                "Cannot inspect automation script '{}': {error}",
                script_path.display()
            )
        })?;

        collect_declared_lua_helpers(&document, collector, &script_path, &mut pending)?;
        if is_automation {
            collect_automation_csv_inputs(&document, collector)?;
        }
        collect_lua_tool_dependencies(&document, collector, &mut pending)?;
    }
    Ok(())
}

fn collect_declared_lua_helpers(
    document: &Value,
    collector: &mut ResourceCollector,
    script_path: &Path,
    pending: &mut VecDeque<PathBuf>,
) -> Result<(), String> {
    let Some(helpers) = document.get("helpers").and_then(Value::as_object) else {
        return Ok(());
    };
    for helper in helpers.values() {
        if helper.get("embedded").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if let Some(path) = helper.get("luaPath").and_then(Value::as_str) {
            let canonical = collector.add_reference(
                path,
                ReferenceKind::File,
                Some(script_path),
                "automation Lua helper",
            )?;
            pending.push_back(canonical);
        }
    }
    Ok(())
}

fn collect_automation_csv_inputs(
    document: &Value,
    collector: &mut ResourceCollector,
) -> Result<(), String> {
    let Some(sources) = document.get("csv").and_then(Value::as_object) else {
        return Ok(());
    };
    for source in sources.values() {
        if let Some(path) = source.get("path").and_then(Value::as_str) {
            if path.contains("${") {
                collector.push_warning(format!(
                    "Runtime-selected automation CSV input was not embedded: {path}"
                ));
                continue;
            }
            if Path::new(path).is_relative() {
                return Err(format!(
                    "Automation CSV input must use an absolute path for snapshotting: {path}"
                ));
            }
            collector.add_reference(path, ReferenceKind::File, None, "automation CSV input")?;
        }
    }
    Ok(())
}

fn collect_lua_tool_dependencies(
    value: &Value,
    collector: &mut ResourceCollector,
    pending: &mut VecDeque<PathBuf>,
) -> Result<(), String> {
    match value {
        Value::Object(object) => {
            if object.get("action").and_then(Value::as_str) == Some("luaTool") {
                if let Some(path) = object.get("luaPath").and_then(Value::as_str) {
                    if Path::new(path).is_relative() {
                        return Err(format!(
                            "Automation luaTool must use an absolute path for snapshotting: {path}"
                        ));
                    }
                    let canonical = collector.add_reference(
                        path,
                        ReferenceKind::File,
                        None,
                        "automation luaTool script",
                    )?;
                    pending.push_back(canonical);
                }
            }
            for child in object.values() {
                collect_lua_tool_dependencies(child, collector, pending)?;
            }
        }
        Value::Array(values) => {
            for child in values {
                collect_lua_tool_dependencies(child, collector, pending)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn sanitize_snapshot_config(config: &mut Value) {
    if let Some(ui) = config.get_mut("ui").and_then(Value::as_object_mut) {
        ui.insert(
            "file_dialog_dirs".to_string(),
            serde_json::json!({ "layout": "", "mcp": "", "protocol": "", "script": "" }),
        );
    }
    if let Some(mcp) = config.get_mut("mcp_tools").and_then(Value::as_object_mut) {
        mcp.insert("enabled".to_string(), Value::Bool(false));
    }
    mark_bundled_canvas_lua_sources(config);
    disable_auto_run(config);
}

fn mark_bundled_canvas_lua_sources(config: &mut Value) {
    let Some(canvases) = config.get_mut("canvases").and_then(Value::as_array_mut) else {
        return;
    };
    for canvas in canvases {
        let Some(canvas_config) = canvas.get_mut("config").and_then(Value::as_object_mut) else {
            continue;
        };
        for key in ["script", "lifecycleScript"] {
            let Some(script) = canvas_config.get_mut(key).and_then(Value::as_object_mut) else {
                continue;
            };
            let has_lua_path = ["luaPath", "yamlPath"].iter().any(|path_key| {
                script
                    .get(*path_key)
                    .and_then(Value::as_str)
                    .is_some_and(|path| !path.trim().is_empty())
            });
            if has_lua_path {
                script.insert("bundled".to_string(), Value::Bool(true));
            }
        }
        let Some(channels) = canvas_config
            .get_mut("channels")
            .and_then(Value::as_array_mut)
        else {
            continue;
        };
        for channel in channels {
            let Some(link) = channel.as_object_mut() else {
                continue;
            };
            let has_protocol_file = link
                .get("protocolFile")
                .and_then(Value::as_str)
                .is_some_and(|path| !path.trim().is_empty());
            if has_protocol_file {
                link.insert("protocolBundled".to_string(), Value::Bool(true));
            }
        }
    }
}

fn disable_auto_run(value: &mut Value) {
    match value {
        Value::Object(object) => {
            if object.contains_key("autoRun") {
                object.insert("autoRun".to_string(), Value::Bool(false));
            }
            for child in object.values_mut() {
                disable_auto_run(child);
            }
        }
        Value::Array(values) => {
            for child in values {
                disable_auto_run(child);
            }
        }
        _ => {}
    }
}

fn build_runtime_aliases(
    aliases: &[PathAlias],
    resources_root: &Path,
) -> Result<Vec<RuntimeAlias>, String> {
    let mut result = Vec::with_capacity(aliases.len());
    for alias in aliases {
        let relative = validate_bundle_path(&alias.bundled_path)?;
        let bundled_root = resources_root.join(relative);
        let mut source_keys = vec![normalized_path_text(&alias.source_path)];
        for reference in &alias.references {
            let key = normalized_path_text(reference);
            if !source_keys.contains(&key) {
                source_keys.push(key);
            }
        }
        result.push(RuntimeAlias {
            source_keys,
            bundled_root,
            is_dir: alias.is_dir,
        });
    }
    result.sort_by_key(|alias| std::cmp::Reverse(alias.source_keys[0].len()));
    Ok(result)
}

fn map_runtime_path(runtime: &SnapshotRuntime, path: &str) -> Option<PathBuf> {
    let key = normalized_path_text(path);
    for alias in &runtime.aliases {
        for source in &alias.source_keys {
            if key == *source {
                return Some(alias.bundled_root.clone());
            }
            if alias.is_dir {
                let prefix = format!("{source}/");
                if let Some(relative) = key.strip_prefix(&prefix) {
                    return Some(join_normalized_relative(&alias.bundled_root, relative));
                }
            }
        }
    }
    None
}

fn reverse_runtime_path(runtime: &SnapshotRuntime, path: &str) -> Option<PathBuf> {
    let key = normalized_path_text(path);
    for alias in &runtime.aliases {
        let bundled_key = normalized_path_key(&alias.bundled_root);
        if key == bundled_key {
            return Some(PathBuf::from(&alias.source_keys[0]));
        }
        if alias.is_dir {
            let prefix = format!("{bundled_key}/");
            if let Some(relative) = key.strip_prefix(&prefix) {
                return Some(join_normalized_relative(
                    &PathBuf::from(&alias.source_keys[0]),
                    relative,
                ));
            }
        }
    }
    None
}

fn rewrite_config_paths(value: &mut Value, aliases: &[RuntimeAlias]) {
    match value {
        Value::String(text) => {
            let runtime = SnapshotRuntime {
                id: String::new(),
                config_path: PathBuf::new(),
                aliases: aliases.to_vec(),
            };
            if let Some(mapped) = map_runtime_path(&runtime, text) {
                *text = mapped.to_string_lossy().into_owned();
            }
        }
        Value::Object(object) => {
            for child in object.values_mut() {
                rewrite_config_paths(child, aliases);
            }
        }
        Value::Array(values) => {
            for child in values {
                rewrite_config_paths(child, aliases);
            }
        }
        _ => {}
    }
}

fn resolve_reference_path(raw: &str, base_file: Option<&Path>) -> Result<PathBuf, String> {
    let path = PathBuf::from(raw);
    if path.is_absolute() {
        return Ok(path);
    }
    let Some(base_file) = base_file else {
        return Err(format!("Snapshot resource path must be absolute: {raw}"));
    };
    let parent = base_file.parent().ok_or_else(|| {
        format!(
            "Snapshot script has no parent directory: {}",
            base_file.display()
        )
    })?;
    Ok(lexical_normalize(&parent.join(path)))
}

fn find_relocated_config_resource(original: &Path) -> Option<PathBuf> {
    let suffix = config_resource_suffix(original)?;
    let mut roots = Vec::new();
    if let Ok(current_dir) = std::env::current_dir() {
        roots.extend(current_dir.ancestors().map(Path::to_path_buf));
    }
    if let Ok(current_exe) = std::env::current_exe() {
        if let Some(parent) = current_exe.parent() {
            roots.extend(parent.ancestors().map(Path::to_path_buf));
        }
    }
    let mut seen = HashSet::new();
    for root in roots {
        let key = normalized_path_key(&root);
        if !seen.insert(key) {
            continue;
        }
        let candidate = root.join(&suffix);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

fn config_resource_suffix(original: &Path) -> Option<PathBuf> {
    let components = original.components().collect::<Vec<_>>();
    let config_index = components.iter().position(|component| {
        matches!(component, Component::Normal(value) if value.to_string_lossy().eq_ignore_ascii_case("config"))
    })?;
    let mut suffix = PathBuf::new();
    for component in &components[config_index..] {
        suffix.push(component.as_os_str());
    }
    Some(suffix)
}

fn lexical_normalize(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

fn normalize_output_path(path: &Path) -> Result<PathBuf, String> {
    let mut output = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .map_err(|error| format!("Cannot resolve current directory: {error}"))?
            .join(path)
    };
    if output.extension().is_none() {
        output.set_extension("exe");
    }
    if output
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase)
        != Some("exe".to_string())
    {
        return Err("Snapshot output must use the .exe extension".to_string());
    }
    Ok(lexical_normalize(&output))
}

fn same_path(left: &Path, right: &Path) -> bool {
    normalized_path_key(left) == normalized_path_key(right)
}

fn normalized_path_key(path: &Path) -> String {
    normalized_path_text(&path.to_string_lossy())
}

fn normalized_path_text(path: &str) -> String {
    let value = path.replace('\\', "/").trim_end_matches('/').to_string();
    #[cfg(target_os = "windows")]
    {
        value.to_ascii_lowercase()
    }
    #[cfg(not(target_os = "windows"))]
    {
        value
    }
}

fn safe_leaf_name(path: &Path) -> String {
    let leaf = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("resource");
    let sanitized = leaf
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || matches!(character, '.' | '-' | '_') {
                character
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.is_empty() {
        "resource".to_string()
    } else {
        sanitized
    }
}

fn join_bundle_path(root: &str, relative: &Path) -> Result<String, String> {
    let mut parts = vec![root.trim_end_matches('/').to_string()];
    for component in relative.components() {
        match component {
            Component::Normal(value) => parts.push(value.to_string_lossy().into_owned()),
            Component::CurDir => {}
            _ => {
                return Err(format!(
                    "Unsafe snapshot resource path: {}",
                    relative.display()
                ))
            }
        }
    }
    Ok(parts.join("/"))
}

fn validate_bundle_path(path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(path);
    if candidate.is_absolute() {
        return Err(format!(
            "Snapshot contains an absolute bundled path: {path}"
        ));
    }
    let mut result = PathBuf::new();
    for component in candidate.components() {
        match component {
            Component::Normal(value) => result.push(value),
            Component::CurDir => {}
            _ => return Err(format!("Snapshot contains an unsafe bundled path: {path}")),
        }
    }
    if result.as_os_str().is_empty() {
        return Err("Snapshot contains an empty bundled path".to_string());
    }
    Ok(result)
}

fn join_normalized_relative(root: &Path, relative: &str) -> PathBuf {
    let mut result = root.to_path_buf();
    for part in relative.split('/') {
        if !part.is_empty() {
            result.push(part);
        }
    }
    result
}

fn snapshot_base_directory() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("APPDATA").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(std::env::temp_dir);
    base.join("LinkAssist").join("Snapshots")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_config_disables_automatic_execution_and_recent_dialog_paths() {
        let mut config = serde_json::json!({
            "ui": { "file_dialog_dirs": { "script": "D:/secret" } },
            "mcp_tools": { "enabled": true, "scripts": [] },
            "canvases": [{
                "config": {
                    "script": { "autoRun": true, "luaPath": "D:/bench.lua" },
                    "lifecycleScript": { "luaPath": "D:/canvas-lifecycle-bench.lua" },
                    "channels": [{ "channelId": "serial-1", "protocolFile": "D:/protocol.lua" }]
                }
            }]
        });
        sanitize_snapshot_config(&mut config);
        assert_eq!(config["mcp_tools"]["enabled"], false);
        assert_eq!(config["canvases"][0]["config"]["script"]["autoRun"], false);
        assert_eq!(config["canvases"][0]["config"]["script"]["bundled"], true);
        assert_eq!(
            config["canvases"][0]["config"]["lifecycleScript"]["bundled"],
            true
        );
        assert_eq!(
            config["canvases"][0]["config"]["channels"][0]["protocolBundled"],
            true
        );
        assert_eq!(config["ui"]["file_dialog_dirs"]["script"], "");
    }

    #[test]
    fn bundled_paths_reject_parent_escape() {
        assert!(validate_bundle_path("resources/tool.lua").is_ok());
        assert!(validate_bundle_path("../tool.lua").is_err());
        assert!(validate_bundle_path("C:/tool.lua").is_err());
    }

    #[test]
    fn bundled_file_resources_preserve_the_original_leaf_name() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-snapshot-lifecycle-leaf-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let lifecycle = directory.join("canvas-lifecycle-bench.lua");
        fs::write(
            &lifecycle,
            "-- linkassist:type = canvas-lifecycle\nreturn { onActivate = { { action = 'log', message = 'ready' } } }\n",
        )
        .unwrap();
        let mut collector = ResourceCollector::new();

        collector
            .add_reference(
                &lifecycle.to_string_lossy(),
                ReferenceKind::File,
                None,
                "canvas lifecycle script",
            )
            .unwrap();

        let bundled_path = Path::new(&collector.aliases[0].bundled_path);
        assert_eq!(
            bundled_path.file_name().and_then(|value| value.to_str()),
            Some("canvas-lifecycle-bench.lua")
        );
        assert_eq!(
            collector.aliases[0].bundled_path,
            "resources/0000/canvas-lifecycle-bench.lua"
        );
        assert!(collector
            .files
            .contains_key("resources/0000/canvas-lifecycle-bench.lua"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn output_names_receive_exe_extension() {
        let output = normalize_output_path(Path::new("bench-backup")).unwrap();
        assert_eq!(
            output.extension().and_then(|value| value.to_str()),
            Some("exe")
        );
    }

    #[test]
    fn missing_loaded_scripts_block_snapshot_creation() {
        let missing = std::env::temp_dir()
            .join(format!("missing-{}.lua", uuid::Uuid::new_v4()))
            .to_string_lossy()
            .into_owned();
        let config = serde_json::json!({
            "canvases": [{ "config": { "script": { "luaPath": missing } } }]
        });
        let mut collector = ResourceCollector::new();
        let mut automation_scripts = Vec::new();

        let error = collect_config_resources(&config, &mut collector, &mut automation_scripts)
            .expect_err("missing loaded Lua must block the snapshot");
        assert!(collector.aliases.is_empty());
        assert!(automation_scripts.is_empty());
        assert!(error.contains("Cannot package missing loaded script"));
    }

    #[test]
    fn relocated_config_resources_keep_the_config_suffix() {
        let original = Path::new("E:/old/workspace/LinkAssist/config/script/example.lua");
        let suffix = config_resource_suffix(original).unwrap();
        assert_eq!(suffix, PathBuf::from("config/script/example.lua"));
    }

    #[test]
    fn runtime_selected_csv_inputs_do_not_block_snapshot_creation() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-snapshot-dynamic-csv-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let script = directory.join("dynamic-csv.lua");
        fs::write(
            &script,
            r#"-- linkassist:type = script
return {
  version = 1,
  name = "Dynamic CSV",
  csv = { commands = { path = "${form.csvPath}" } },
  steps = { { action = "log", message = "ready" } },
}
"#,
        )
        .unwrap();
        let mut collector = ResourceCollector::new();

        collect_automation_dependencies(&mut collector, vec![script]).unwrap();

        assert_eq!(collector.warnings.len(), 1);
        assert_eq!(
            collector.warnings[0],
            "Runtime-selected automation CSV input was not embedded: ${form.csvPath}"
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn lifecycle_lua_helpers_are_collected() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-snapshot-lifecycle-helper-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let lifecycle = directory.join("canvas-lifecycle-helper.lua");
        let helper = directory.join("helper.lua");
        fs::write(
            &lifecycle,
            r#"-- linkassist:type = canvas-lifecycle
return {
  helpers = { shared = { luaPath = "helper.lua" } },
  onActivate = {
    { action = "luaHelper", helper = "shared", func = "prepare", args = {} },
  },
}
"#,
        )
        .unwrap();
        fs::write(
            &helper,
            "-- linkassist:type = script-helper\nfunction helpers() return {{ name = 'prepare' }} end\nfunction call() return {} end\n",
        )
        .unwrap();
        let mut collector = ResourceCollector::new();

        collect_automation_dependencies(&mut collector, vec![lifecycle]).unwrap();

        assert_eq!(collector.aliases.len(), 1);
        assert_eq!(collector.files.len(), 1);
        assert!(collector.aliases[0].source_path.ends_with("helper.lua"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn snapshot_executable_round_trips_embedded_payload() {
        let directory = std::env::temp_dir().join(format!(
            "linkassist-snapshot-roundtrip-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&directory).unwrap();
        let output = directory.join("portable.exe");
        let script = directory.join("bench.lua");
        fs::write(
            &script,
            "-- linkassist:type = script\nreturn { steps = { { action = 'log', message = 'ready' } } }\n",
        )
        .unwrap();
        let report = create_snapshot(
            &output,
            serde_json::json!({
                "channels": [],
                "ui": {},
                "protocol": {},
                "canvases": [{
                    "config": {
                        "script": { "luaPath": script.to_string_lossy() },
                        "channels": []
                    }
                }],
                "mcp_tools": { "enabled": true, "scripts": [] }
            }),
        )
        .unwrap();

        let embedded = embedded_payload_from_path(&output).unwrap().unwrap();
        assert_eq!(embedded.payload.format_version, SNAPSHOT_FORMAT_VERSION);
        assert_eq!(hex::encode(embedded.digest), report.snapshot_id);
        assert_eq!(embedded.payload.config["mcp_tools"]["enabled"], false);
        assert_eq!(
            embedded.payload.config["canvases"][0]["config"]["script"]["bundled"],
            true
        );
        assert_eq!(embedded.payload.files.len(), 1);
        assert_eq!(embedded.payload.aliases.len(), 1);

        fs::remove_dir_all(directory).unwrap();
    }
}
