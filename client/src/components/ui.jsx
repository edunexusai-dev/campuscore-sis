import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, Info, Loader2, X, Inbox, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react';

const cx = (...c) => c.filter(Boolean).join(' ');
export { cx };

// ── Buttons ──
const BTN = {
  primary: 'bg-ink-900 text-white hover:bg-ink-800 shadow-sm',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-xs',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-sm',
  subtleDanger: 'text-red-700 hover:bg-red-50 border border-red-200 bg-white',
  accent: 'bg-brass-300 text-ink-950 hover:bg-brass-400 shadow-sm',
};
export function Button({ variant = 'primary', size = 'md', loading, icon: Icon, className, children, disabled, ...props }) {
  return (
    <button
      type="button"
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap', size === 'sm' ? 'text-[13px] px-2.5 py-1.5' : 'text-sm px-3.5 py-2', BTN[variant], className)}
      disabled={disabled || loading}
      {...props}
    >
      {loading ? <Loader2 className="size-4 animate-spin" aria-hidden /> : Icon ? <Icon className="size-4" aria-hidden /> : null}
      {children}
    </button>
  );
}

// ── Layout primitives ──
export function PageHeader({ title, subtitle, actions, back, eyebrow }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        {back && <Link to={back.to} className="mb-2 inline-flex items-center gap-1 text-[13px] font-medium text-slate-500 hover:text-slate-800"><ChevronLeft className="size-4" />{back.label}</Link>}
        {eyebrow && <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-brass-600">{eyebrow}</div>}
        <h1 className="font-serif text-[26px] leading-tight font-semibold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Card({ title, subtitle, actions, children, className, padded = true, footer }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
          <div className="min-w-0">
            {title && <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-[13px] text-slate-500">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-5' : ''}>{children}</div>
      {footer && <footer className="border-t border-slate-100 px-5 py-3">{footer}</footer>}
    </section>
  );
}

export function Stat({ label, value, hint, icon: Icon, tone = 'ink', to }) {
  const tones = { ink: 'bg-ink-50 text-ink-700', brass: 'bg-brass-50 text-brass-700', green: 'bg-emerald-50 text-emerald-700', red: 'bg-red-50 text-red-700', slate: 'bg-slate-100 text-slate-600' };
  const body = (
    <div className="card flex items-start gap-4 p-4 h-full">
      {Icon && <div className={cx('rounded-lg p-2.5', tones[tone])}><Icon className="size-5" aria-hidden /></div>}
      <div className="min-w-0">
        <div className="text-[13px] font-medium text-slate-500">{label}</div>
        <div className="mt-0.5 text-2xl font-semibold tracking-tight text-slate-900 tabular-nums">{value}</div>
        {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
      </div>
    </div>
  );
  return to ? <Link to={to} className="block hover:-translate-y-px transition-transform">{body}</Link> : body;
}

export function KeyValue({ items, cols = 2 }) {
  return (
    <dl className={cx('grid gap-x-6 gap-y-4', cols === 3 ? 'sm:grid-cols-3' : cols === 1 ? '' : 'sm:grid-cols-2')}>
      {items.filter(Boolean).map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{k}</dt>
          <dd className="mt-0.5 text-sm text-slate-900 break-words">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

// ── Status badges ──
const BADGE = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  blue: 'bg-sky-50 text-sky-700 ring-sky-600/20',
  ink: 'bg-ink-50 text-ink-700 ring-ink-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/25',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  slate: 'bg-slate-100 text-slate-600 ring-slate-500/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
};
const STATUS_TONE = {
  ACTIVE: 'green', REGISTERED: 'green', PUBLISHED: 'green', COMPLETED: 'green', APPROVED: 'green', OPEN: 'green', GOOD: 'green', PRESENT: 'green', ADMITTED: 'green', MATRICULATED: 'ink', IN_PROGRESS: 'blue', REGISTRATION_OPEN: 'blue',
  DEANS_LIST: 'violet', SUBMITTED: 'blue', PROCESSING: 'blue', UNDER_REVIEW: 'blue', WAITLISTED: 'amber', DRAFT: 'slate', PLANNED: 'slate', PENDING: 'amber', LATE: 'amber', RETURNED: 'amber', PROBATION: 'amber', LEAVE_OF_ABSENCE: 'amber', CLOSED: 'slate', EXCUSED: 'slate', APPLICANT: 'slate',
  DROPPED: 'slate', WITHDRAWN: 'slate', CANCELLED: 'red', REJECTED: 'red', ABSENT: 'red', SUSPENDED: 'red', SUSPENSION: 'red', DISABLED: 'red', REVOKED: 'red', EXPIRED: 'slate', SUPERSEDED: 'slate', GRADUATED: 'ink', MISSING: 'red',
};
export function Badge({ children, tone, status, className }) {
  const t = tone ?? STATUS_TONE[status] ?? 'slate';
  const text = children ?? (status ? status.toLowerCase().replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()) : '');
  return <span className={cx('inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', BADGE[t], className)}>{text}</span>;
}

// ── Form controls ──
export function Field({ label, error, hint, children, required, className }) {
  const id = useId();
  const child = typeof children === 'function' ? children(id) : children;
  return (
    <div className={className}>
      {label && <label htmlFor={id} className="label">{label}{required && <span className="text-red-600"> *</span>}</label>}
      {child}
      {error ? <p className="mt-1 text-xs text-red-600" role="alert">{error}</p> : hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
    </div>
  );
}
export const Input = ({ className, ...p }) => <input className={cx('input', className)} {...p} />;
export const Textarea = ({ className, ...p }) => <textarea className={cx('input min-h-[90px]', className)} {...p} />;
export function Select({ className, options, placeholder, ...p }) {
  return (
    <select className={cx('input pr-8', className)} {...p}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (typeof o === 'string' ? <option key={o} value={o}>{o}</option> : <option key={o.value} value={o.value} disabled={o.disabled}>{o.label}</option>))}
    </select>
  );
}
export function Toggle({ checked, onChange, label, disabled, id }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} id={id} disabled={disabled} onClick={() => onChange(!checked)}
      className={cx('relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50', checked ? 'bg-ink-800' : 'bg-slate-300')}>
      <span className={cx('inline-block size-5 rounded-full bg-white shadow transition-transform', checked ? 'translate-x-5' : 'translate-x-0.5')} />
    </button>
  );
}
export function Checkbox({ label, checked, onChange, description, disabled }) {
  return (
    <label className={cx('flex items-start gap-2.5 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="mt-0.5 size-4 rounded border-slate-300 text-ink-800 accent-ink-800" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span><span className="font-medium text-slate-800">{label}</span>{description && <span className="block text-xs text-slate-500">{description}</span>}</span>
    </label>
  );
}

// ── Feedback ──
export function Spinner({ label = 'Loading…' }) {
  return <div className="flex items-center justify-center gap-2 py-12 text-sm text-slate-500" role="status"><Loader2 className="size-5 animate-spin" aria-hidden />{label}</div>;
}
export function Empty({ title = 'Nothing here yet', description, icon: Icon = Inbox, action }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <div className="rounded-full bg-slate-100 p-3 text-slate-400"><Icon className="size-6" aria-hidden /></div>
      <p className="mt-3 text-sm font-medium text-slate-800">{title}</p>
      {description && <p className="mt-1 max-w-sm text-sm text-slate-500">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
export function Alert({ tone = 'info', title, children, className }) {
  const s = { info: ['bg-sky-50 border-sky-200 text-sky-900', Info], warn: ['bg-amber-50 border-amber-200 text-amber-900', AlertTriangle], error: ['bg-red-50 border-red-200 text-red-900', AlertTriangle], success: ['bg-emerald-50 border-emerald-200 text-emerald-900', CheckCircle2] }[tone];
  const Icon = s[1];
  return (
    <div className={cx('flex gap-3 rounded-lg border px-4 py-3 text-sm', s[0], className)} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="min-w-0">{title && <p className="font-semibold">{title}</p>}<div className={title ? 'mt-0.5' : ''}>{children}</div></div>
    </div>
  );
}
export function ErrorState({ error, retry }) {
  return (
    <div className="p-6"><Alert tone="error" title="Something went wrong">{error?.message ?? 'The request failed.'}{retry && <button className="link ml-2" onClick={retry}>Try again</button>}</Alert></div>
  );
}
export function ApiErrorDetails({ error }) {
  if (!error) return null;
  const details = Array.isArray(error.details) ? error.details : null;
  return (
    <Alert tone="error" title={error.message}>
      {details && <ul className="mt-1 list-disc pl-4 space-y-0.5">{details.map((d, i) => <li key={i}>{d.message ?? JSON.stringify(d)}{d.field && d.field !== '(root)' ? <span className="text-red-700/70"> ({d.field})</span> : null}</li>)}</ul>}
      {error.code && <p className="mt-1 text-xs opacity-70">Code: <span className="mono">{error.code}</span></p>}
    </Alert>
  );
}

// ── Toasts ──
const ToastCtx = createContext(() => {});
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, tone = 'success') => {
    const id = Math.random();
    setToasts((t) => [...t, { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-[60] flex w-[min(92vw,380px)] flex-col gap-2" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={cx('flex items-start gap-2.5 rounded-lg border px-4 py-3 text-sm shadow-lg', t.tone === 'error' ? 'border-red-200 bg-white text-red-800' : 'border-slate-200 bg-ink-950 text-white')}>
            {t.tone === 'error' ? <AlertTriangle className="mt-0.5 size-4 shrink-0" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-brass-300" />}
            <span className="flex-1">{t.message}</span>
            <button onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))} aria-label="Dismiss" className="opacity-60 hover:opacity-100"><X className="size-4" /></button>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

// ── Modal dialog (Esc to close, focus moved inside, background inert) ──
export function Modal({ open, onClose, title, description, children, footer, size = 'md' }) {
  const ref = useRef(null);
  // Callers often pass a new onClose each render; keep it in a ref so focus handling runs only on open/close.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return undefined;
    const prev = document.activeElement;
    const onKey = (e) => { if (e.key === 'Escape') onCloseRef.current(); };
    document.addEventListener('keydown', onKey);
    const t = setTimeout(() => ref.current?.querySelector('input,select,textarea,button:not([data-close])')?.focus(), 10);
    document.body.style.overflow = 'hidden';
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); document.body.style.overflow = ''; prev?.focus?.(); };
  }, [open]);
  if (!open) return null;
  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center p-0 sm:p-4">
      <div className="absolute inset-0 bg-ink-950/50 backdrop-blur-[1px]" onClick={onClose} aria-hidden />
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="modal-title" className={cx('relative flex max-h-[92vh] w-full flex-col rounded-t-2xl sm:rounded-xl bg-white shadow-2xl', width)}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4">
          <div><h2 id="modal-title" className="text-base font-semibold text-slate-900">{title}</h2>{description && <p className="mt-0.5 text-sm text-slate-500">{description}</p>}</div>
          <button data-close onClick={onClose} className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700" aria-label="Close dialog"><X className="size-5" /></button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmDialog({ open, onClose, onConfirm, title, children, confirmLabel = 'Confirm', tone = 'danger', loading, requireText }) {
  const [typed, setTyped] = useState('');
  useEffect(() => { if (!open) setTyped(''); }, [open]);
  return (
    <Modal open={open} onClose={onClose} title={title} size="sm"
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant={tone === 'danger' ? 'danger' : 'primary'} onClick={onConfirm} loading={loading} disabled={requireText && typed !== requireText}>{confirmLabel}</Button></>}>
      <div className="text-sm text-slate-600 space-y-3">{children}</div>
      {requireText && <Field label={<>Type <span className="mono font-semibold">{requireText}</span> to confirm</>} className="mt-4"><Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" /></Field>}
    </Modal>
  );
}

// ── Tabs ──
export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="mb-5 border-b border-slate-200 overflow-x-auto">
      <nav className="-mb-px flex gap-5" role="tablist">
        {tabs.map((t) => (
          <button key={t.value} role="tab" aria-selected={value === t.value} onClick={() => onChange(t.value)}
            className={cx('whitespace-nowrap border-b-2 px-0.5 pb-2.5 text-sm font-medium transition-colors', value === t.value ? 'border-ink-800 text-ink-900' : 'border-transparent text-slate-500 hover:text-slate-800 hover:border-slate-300')}>
            {t.label}{t.count != null && <span className={cx('ml-1.5 rounded-full px-1.5 py-0.5 text-[11px]', value === t.value ? 'bg-ink-100 text-ink-800' : 'bg-slate-100 text-slate-600')}>{t.count}</span>}
          </button>
        ))}
      </nav>
    </div>
  );
}

// ── Data table ──
// columns: [{ key, header, render?, sortable?, className?, align? }]
export function DataTable({ columns, rows, loading, empty, onRowClick, sort, onSort, rowKey = (r) => r.id, dense }) {
  if (loading) return <Spinner />;
  if (!rows?.length) return empty ?? <Empty />;
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full">
        <thead>
          <tr>
            {columns.map((c) => {
              const active = sort && sort.replace(/^-/, '') === c.key;
              const SortIcon = !active ? ArrowUpDown : sort.startsWith('-') ? ArrowDown : ArrowUp;
              return (
                <th key={c.key} className={cx('th', c.align === 'right' && 'text-right', c.className)} aria-sort={active ? (sort.startsWith('-') ? 'descending' : 'ascending') : undefined}>
                  {c.sortable && onSort ? (
                    <button className="inline-flex items-center gap-1 uppercase hover:text-slate-800" onClick={() => onSort(active && !sort.startsWith('-') ? `-${c.key}` : c.key)}>{c.header}<SortIcon className={cx('size-3', active ? 'text-slate-700' : 'text-slate-300')} /></button>
                  ) : c.header}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={rowKey(r, i)} onClick={onRowClick ? () => onRowClick(r) : undefined} onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(r); } : undefined} tabIndex={onRowClick ? 0 : undefined}
              className={cx(onRowClick && 'cursor-pointer hover:bg-ink-50/50 focus:bg-ink-50/60 focus:outline-none')}>
              {columns.map((c) => <td key={c.key} className={cx('td', dense && 'py-2', c.align === 'right' && 'text-right tabular-nums', c.className)}>{c.render ? c.render(r) : r[c.key] ?? '—'}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.total === 0) return null;
  const { page, pageSize, total, totalPages } = pagination;
  return (
    <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-600">
      <span className="tabular-nums">{(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}</span>
      <div className="flex items-center gap-1">
        <Button size="sm" variant="secondary" icon={ChevronLeft} disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Previous page" />
        <span className="px-2 tabular-nums">Page {page} of {totalPages}</span>
        <Button size="sm" variant="secondary" icon={ChevronRight} disabled={page >= totalPages} onClick={() => onPage(page + 1)} aria-label="Next page" />
      </div>
    </div>
  );
}

// Debounced search input for server-side filtering.
export function SearchInput({ value, onChange, placeholder = 'Search…', className }) {
  const [v, setV] = useState(value ?? '');
  useEffect(() => { setV(value ?? ''); }, [value]);
  useEffect(() => { const t = setTimeout(() => { if (v !== (value ?? '')) onChange(v); }, 300); return () => clearTimeout(t); }, [v]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Input type="search" value={v} onChange={(e) => setV(e.target.value)} placeholder={placeholder} aria-label={placeholder} className={cx('max-w-xs', className)} />;
}

export function Planned({ children }) {
  return <span className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide text-slate-500" title="Not available in this release">Planned{children ? ` · ${children}` : ''}</span>;
}

export function SecretBox({ value, label }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      {label && <div className="label">{label}</div>}
      <div className="flex items-center gap-2 rounded-lg border border-slate-300 bg-slate-50 px-3 py-2">
        <code className="mono flex-1 break-all text-slate-900">{value}</code>
        <Button size="sm" variant="secondary" onClick={async () => { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); }}>{copied ? 'Copied' : 'Copy'}</Button>
      </div>
    </div>
  );
}
