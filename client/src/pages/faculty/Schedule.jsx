import { useApi } from '../../lib/hooks.js';
import { PageHeader, Card, Spinner, Empty, ErrorState } from '../../components/ui.jsx';
import WeeklySchedule from '../../components/WeeklySchedule.jsx';

export default function FacultySchedule() {
  const { data, isLoading, error } = useApi('/faculty/schedule');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  return (
    <>
      <PageHeader title="Teaching schedule" subtitle={data.data.term?.name} />
      <Card>{data.data.classes.length ? <WeeklySchedule classes={data.data.classes} /> : <Empty title="No classes scheduled" />}</Card>
    </>
  );
}
