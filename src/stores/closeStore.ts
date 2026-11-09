import { create } from 'zustand';
export type CloseChoice = 'exit' | 'background' | 'cancel';
export const useCloseStore = create<{
  reason: 'first' | 'remote' | null;
  resolve: ((choice: CloseChoice, always?: boolean) => void) | null;
}>(() => ({ reason: null, resolve: null }));

export function askCloseChoice(reason: 'first' | 'remote'): Promise<{ choice: CloseChoice; always: boolean }> {
  return new Promise(resolve => useCloseStore.setState({ reason, resolve: (choice, always = false) => {
    useCloseStore.setState({ reason: null, resolve: null }); resolve({ choice, always });
  } }));
}
