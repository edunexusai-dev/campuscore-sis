import { Printer } from 'lucide-react';
import { useApi } from '../../lib/hooks.js';
import { Spinner, Button, PageHeader, ErrorState } from '../../components/ui.jsx';
import TranscriptView from '../../components/TranscriptView.jsx';

export default function StudentTranscript() {
  const { data, isLoading, error } = useApi('/student/transcript');
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <Spinner />;
  return (
    <>
      <div className="no-print"><PageHeader title="Unofficial transcript" subtitle="For your records. Official transcripts can be requested under Document requests." actions={<Button variant="secondary" icon={Printer} onClick={() => window.print()}>Print / save as PDF</Button>} /></div>
      <TranscriptView t={data.data} />
    </>
  );
}
