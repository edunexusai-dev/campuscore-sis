import { useState } from 'react';
import { Mail, Phone, MapPin } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { qs } from '../../lib/api.js';
import { PageHeader, Card, Spinner, Empty, SearchInput, Tabs, ErrorState } from '../../components/ui.jsx';

export default function Directory() {
  const [search, setSearch] = useState('');
  const [tab, setTab] = useState('people');
  const { data, isLoading, error } = useApi(`/directory${qs({ search })}`);
  return (
    <>
      <PageHeader title="Campus directory" subtitle="Faculty and academic departments. Student information is not published in the directory." actions={<SearchInput value={search} onChange={setSearch} placeholder="Search name or department" />} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'people', label: 'Faculty', count: data?.data.people.length }, { value: 'departments', label: 'Departments', count: data?.data.departments.length }]} />
      {error ? <ErrorState error={error} /> : isLoading ? <Spinner /> : tab === 'people' ? (
        !data.data.people.length ? <Card><Empty title="No matches" /></Card> : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {data.data.people.map((p) => (
              <div key={p.id} className="card p-4">
                <div className="font-medium text-slate-900">{p.name}</div>
                <div className="text-[13px] text-slate-500">{p.title}</div>
                <div className="mt-3 space-y-1 text-[13px] text-slate-600">
                  <div className="flex items-center gap-2"><Mail className="size-3.5 text-slate-400" /><a className="link font-normal" href={`mailto:${p.email}`}>{p.email}</a></div>
                  {p.phone && <div className="flex items-center gap-2"><Phone className="size-3.5 text-slate-400" />{p.phone}</div>}
                  {p.office && <div className="flex items-center gap-2"><MapPin className="size-3.5 text-slate-400" />{p.office}{p.officeHours && <span className="text-slate-400"> · {p.officeHours}</span>}</div>}
                </div>
              </div>
            ))}
          </div>
        )
      ) : (
        <Card padded={false}>
          <ul className="divide-y divide-slate-100">
            {data.data.departments.map((d) => (
              <li key={d.id} className="flex flex-col gap-1 px-5 py-3 sm:flex-row sm:items-center sm:justify-between">
                <div><div className="font-medium text-slate-900">{d.name} <span className="text-slate-400 font-normal">({d.code})</span></div><div className="text-[13px] text-slate-500">{d.college}</div></div>
                <div className="text-[13px] text-slate-600">{d.office} · <a href={`mailto:${d.email}`} className="link font-normal">{d.email}</a></div>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </>
  );
}
