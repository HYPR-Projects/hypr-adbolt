import { create } from 'zustand';
import type { AppView } from '@/types';

export interface Toast {
  id: number;
  message: string;
  type: '' | 'success' | 'error';
  undoAction?: () => void;
}

interface UIState {
  currentView: AppView;
  theme: 'dark' | 'light';
  toasts: Toast[];
  _toastCounter: number;

  setView: (view: AppView) => void;
  toggleTheme: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  toast: (message: string, type?: '' | 'success' | 'error', undoAction?: () => void) => void;
  dismissToast: (id: number) => void;
}

export const useUIStore = create<UIState>((set, get) => ({
  currentView: 'home',
  theme: (localStorage.getItem('hypr-theme') as 'dark' | 'light') || 'dark',
  toasts: [],
  _toastCounter: 0,

  setView: (view) => set({ currentView: view }),

  toggleTheme: () => {
    const next = get().theme === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('hypr-theme', next);
    set({ theme: next });
  },

  setTheme: (theme) => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('hypr-theme', theme);
    set({ theme });
  },

  toast: (message, type = '', undoAction) => {
    const id = get()._toastCounter + 1;
    const toast: Toast = { id, message, type, undoAction };

    // Replace existing toasts (only 1 visible at a time, like original)
    set({ toasts: [toast], _toastCounter: id });

    // Auto-dismiss non-error toasts after 3.2s (matching original)
    if (type !== 'error') {
      setTimeout(() => {
        const { toasts } = get();
        if (toasts.some((t) => t.id === id)) {
          set({ toasts: toasts.filter((t) => t.id !== id) });
        }
      }, 3200);
    }
  },

  dismissToast: (id) => {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));
