use glib::prelude::*;

// Run in release mode: the old immutable FFI out-pointer is UB and may only
// fail when the compiler optimizes away the foreign write (RUSTSEC-2024-0429).
#[test]
fn string_array_iteration_preserves_borrowed_values() {
    let expected = ["", "ASCII", "蓝牙", "🦀", "last"];
    let variant = expected.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().collect::<Vec<_>>(), expected);
    assert_eq!(variant.array_iter_str().unwrap().rev().collect::<Vec<_>>(), expected.into_iter().rev().collect::<Vec<_>>());
    let mut iterator = variant.array_iter_str().unwrap();
    let first = iterator.next().unwrap();
    assert_eq!(iterator.next_back(), Some("last"));
    assert_eq!(iterator.nth(1), Some("蓝牙"));
    assert_eq!(iterator.nth_back(0), Some("🦀"));
    assert_eq!(iterator.len(), 0);
    assert_eq!(iterator.next(), None);
    assert_eq!(iterator.next_back(), None);
    drop(iterator);
    assert_eq!(first, "");
    assert_eq!(variant.array_iter_str().unwrap().last(), Some("last"));
}

#[test]
fn empty_and_exhausted_string_arrays_are_fused() {
    let empty: Vec<&str> = vec![];
    let variant = empty.to_variant();
    assert_eq!(variant.array_iter_str().unwrap().next(), None);
    let variant = ["one", "two"].to_variant();
    let mut iterator = variant.array_iter_str().unwrap();
    assert_eq!(iterator.nth(2), None);
    assert_eq!(iterator.next_back(), None);
    let mut iterator = variant.array_iter_str().unwrap();
    assert_eq!(iterator.nth_back(2), None);
    assert_eq!(iterator.next(), None);
}
