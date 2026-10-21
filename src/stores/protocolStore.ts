import { create } from 'zustand';
import { ParserMode, FieldDefinition } from '../types';

interface ProtocolStore {
  mode: ParserMode;
  fieldDefinitions: FieldDefinition[];
  luaScript: string;

  // Parser channel linking
  linkedChannelId: string | null;
  linkedServiceUuid: string | null;
  linkedCharUuid: string | null;
  
  setMode: (mode: ParserMode) => void;
  setFieldDefinitions: (fields: FieldDefinition[]) => void;
  setLuaScript: (script: string) => void;

  // Parser channel linking setters
  setLinkedChannel: (channelId: string | null) => void;
  setLinkedService: (uuid: string | null) => void;
  setLinkedChar: (uuid: string | null) => void;
}

export const useProtocolStore = create<ProtocolStore>((set) => ({
  mode: 'Passthrough',
  fieldDefinitions: [],
  luaScript: '',

  linkedChannelId: null,
  linkedServiceUuid: null,
  linkedCharUuid: null,
  
  setMode: (mode) => set({ mode }),
  setFieldDefinitions: (fieldDefinitions) => set({ fieldDefinitions }),
  setLuaScript: (luaScript) => set({ luaScript }),

  setLinkedChannel: (channelId) => set({ linkedChannelId: channelId, linkedServiceUuid: null, linkedCharUuid: null }),
  setLinkedService: (uuid) => set({ linkedServiceUuid: uuid, linkedCharUuid: null }),
  setLinkedChar: (uuid) => set({ linkedCharUuid: uuid }),
}));
