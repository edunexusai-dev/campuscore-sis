import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import { api } from './api.js';
import { useToast } from '../components/ui.jsx';

export const useApi = (path, opts = {}) => useQuery({ queryKey: [path], queryFn: () => api.get(path), enabled: path != null && (opts.enabled ?? true), ...opts });

// Mutation that toasts on success/failure and invalidates queries whose key starts with any prefix given.
export function useAction(fn, { success, invalidate = [], onSuccess, toastErrors = true } = {}) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: (data, vars) => {
      if (success) toast(typeof success === 'function' ? success(data, vars) : success);
      for (const prefix of invalidate) qc.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith(prefix) });
      onSuccess?.(data, vars);
    },
    onError: (e) => { if (toastErrors) toast(e.message, 'error'); },
  });
}

// URL-backed list state (search/filter/sort/page) so tables are linkable and survive reloads.
export function useListParams(defaults = {}) {
  const [params, setParams] = useSearchParams();
  const get = (k) => params.get(k) ?? defaults[k] ?? '';
  const set = (patch) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) { if (v === '' || v == null) next.delete(k); else next.set(k, v); }
    if (!('page' in patch)) next.delete('page');
    setParams(next, { replace: true });
  };
  const all = Object.fromEntries([...new Set([...Object.keys(defaults), ...params.keys()])].map((k) => [k, get(k)]));
  return [all, set];
}
