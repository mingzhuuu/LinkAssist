export type ParserMode = 'Passthrough' | 'FieldDefinition' | 'LuaScript';

export type FieldType = 
  | 'UInt8' | 'UInt16LE' | 'UInt16BE' | 'UInt32LE' | 'UInt32BE'
  | 'Int8' | 'Int16LE' | 'Int16BE' | 'Int32LE' | 'Int32BE'
  | 'Float32LE' | 'Float32BE' | 'Float64LE' | 'Float64BE'
  | 'Bool'
  | { ByteArray: number }
  | { Utf8String: number };

export type DisplayFormat = 'Decimal' | 'Hex' | 'Binary' | 'Ascii' | 'Auto';

export interface FieldDefinition {
  id?: string;
  alias?: string;
  name: string;
  field_type: FieldType;
  offset: number;
  description: string;
  display_format: DisplayFormat;
}

export interface ParsedField {
  id?: string;
  alias?: string;
  name: string;
  raw_bytes: number[];
  value: number | string | boolean | number[];
  display: string;
}

export interface ProtocolFieldSummary {
  id: string;
  name: string;
  fieldType: string;
  description: string;
  displayFormat: string;
}

export interface ProtocolFileSummary {
  filePath: string;
  name: string;
  fields: ProtocolFieldSummary[];
}

export interface DataGroup {
  name: string;
  fields: ParsedField[];
}

export interface ParseResult {
  fields: ParsedField[];
  remaining_bytes: number[];
  data_groups: DataGroup[];
}

export interface ProtocolTemplate {
  id: string;
  name: string;
  description: string;
  fields: FieldDefinition[];
}
