import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useNavigate, Navigate } from 'react-router-dom';
import { User } from '../types';
import { apiUrl, getFileUrl } from '../config';
import { useSocket } from '../contexts/SocketContext';

interface SubmissionsPageProps {
  currentUser: User;
}

interface InboxRow {
  id: number;
  status: 'pending' | 'approved' | 'rejected' | null;
  submitted_at: string;
  is_viewed: boolean;
  file_name: string | null;
  file_size: number | null;
  comment: string;
  user_id: number;
  user_name: string;
  user_avatar: string | null;
  task_id: number;
  task_title: string;
  task_type: 'mandatory' | 'optional';
  xp_reward: number;
  lesson_id: number;
  lesson_title: string;
  path_id: number;
  path_name: string;
  phase_order: number;
  course_id: number | null;
  course_name: string | null;
}

type Filter = 'pending' | 'approved' | 'rejected' | 'all';

// The URL that opens the lesson and task on the course road (CoursePage reads ?lesson=&task=).
export const submissionDeepLink = (row: { course_id: number | null; lesson_id: number; task_id: number }) =>
  row.course_id ? `/courses/${row.course_id}?lesson=${row.lesson_id}&task=${row.task_id}` : null;

const shortPhase = (name: string) => {
  const m = name.match(/^(phase|faza|etapa|level|stage|week|part)\s*\d+/i);
  return m ? m[0] : name;
};

// Admin review inbox: every submission in one place, newest first, with a deep link to its lesson.
export const SubmissionsPage: React.FC<SubmissionsPageProps> = ({ currentUser }) => {
  const navigate = useNavigate();
  const { socket } = useSocket();
  const [filter, setFilter] = useState<Filter>('pending');
  const [rows, setRows] = useState<InboxRow[]>([]);
  const [counts, setCounts] = useState({ pending: 0, approved: 0, rejected: 0 });
  const [loaded, setLoaded] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const PAGE = 50;

  // First page (also used to refresh after live events); older pages are appended by loadMore().
  const fetchInbox = useCallback(async () => {
    try {
      const res = await fetch(apiUrl(`/admin/submissions?status=${filter}&limit=${PAGE}`), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRows(data.submissions);
        setCounts(data.counts);
        setHasMore(!!data.has_more);
        setNextCursor(data.next_cursor ?? null);
      }
    } catch (err) {
      console.error('Failed to fetch submissions', err);
    } finally {
      setLoaded(true);
    }
  }, [filter]);

  const loadMore = useCallback(async () => {
    if (!hasMore || nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch(apiUrl(`/admin/submissions?status=${filter}&limit=${PAGE}&before=${nextCursor}`), { credentials: 'include' });
      if (res.ok) {
        const data = await res.json();
        setRows((prev) => {
          const known = new Set(prev.map((r) => r.id));
          return [...prev, ...data.submissions.filter((r: InboxRow) => !known.has(r.id))];
        });
        setHasMore(!!data.has_more);
        setNextCursor(data.next_cursor ?? null);
      }
    } catch (err) {
      console.error('Failed to load more submissions', err);
    } finally {
      setLoadingMore(false);
    }
  }, [filter, hasMore, nextCursor, loadingMore]);

  useEffect(() => { setLoaded(false); fetchInbox(); }, [fetchInbox]);

  // Infinite scroll: when the sentinel below the list becomes visible, fetch the next page
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !hasMore) return;
    const io = new IntersectionObserver((entries) => { if (entries.some((e) => e.isIntersecting)) loadMore(); }, { rootMargin: '400px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, [hasMore, loadMore]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchInbox();
    ['task:submission_uploaded', 'task:completed', 'task:updated', 'task:deleted', 'lesson:deleted'].forEach((e) => socket.on(e, refresh));
    return () => { ['task:submission_uploaded', 'task:completed', 'task:updated', 'task:deleted', 'lesson:deleted'].forEach((e) => socket.off(e, refresh)); };
  }, [socket, fetchInbox]);

  if (currentUser.role !== 'admin') return <Navigate to="/courses" replace />;

  const tabs: { key: Filter; label: string; count?: number }[] = [
    { key: 'pending', label: 'To review', count: counts.pending },
    { key: 'approved', label: 'Approved', count: counts.approved },
    { key: 'rejected', label: 'Rejected', count: counts.rejected },
    { key: 'all', label: 'All' },
  ];

  const when = (iso: string) => {
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 60000;
    if (diff < 60) return `${Math.max(1, Math.round(diff))} min ago`;
    if (diff < 60 * 24) return `${Math.round(diff / 60)} h ago`;
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  };

  const chip = (status: InboxRow['status']) =>
    status === 'approved' ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
      : status === 'rejected' ? 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300'
        : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300';

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-6xl mx-auto bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 p-6 sm:p-8 shadow-sm">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-6">
          <div>
            <h2 className="text-3xl font-extrabold italic text-gray-700 dark:text-gray-200">Submissions</h2>
            <p className="text-sm text-gray-500 dark:text-gray-400">Everything students handed in, newest first. Open a row to review it on the course road.</p>
          </div>
          <div className="flex items-center gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
            {tabs.map((t) => (
              <button
                key={t.key}
                onClick={() => setFilter(t.key)}
                className={`px-3 py-1.5 rounded-lg text-sm font-bold flex items-center gap-1.5 ${filter === t.key ? 'bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white' : 'text-gray-500'}`}
              >
                {t.label}
                {t.count !== undefined && (
                  <span className={`min-w-[20px] h-5 px-1.5 rounded-full text-[11px] flex items-center justify-center ${t.key === 'pending' && t.count > 0 ? 'bg-red-500 text-white' : 'bg-gray-200 dark:bg-gray-600 text-gray-600 dark:text-gray-200'}`}>{t.count}</span>
                )}
              </button>
            ))}
          </div>
        </div>

        {loaded && rows.length === 0 && (
          <div className="text-center py-16 text-gray-400">
            <span className="material-icons text-6xl text-gray-300 dark:text-gray-600 mb-3">inbox</span>
            <p className="font-semibold">{filter === 'pending' ? 'Nothing to review. 🎉' : 'No submissions here.'}</p>
          </div>
        )}

        <div className="space-y-2">
          {rows.map((row) => {
            const link = submissionDeepLink(row);
            return (
              <div
                key={row.id}
                onClick={() => link && navigate(link)}
                className={`group flex items-start gap-4 rounded-2xl border px-4 py-3 bg-white dark:bg-gray-800 transition-shadow ${link ? 'cursor-pointer hover:shadow-md' : ''} ${
                  (row.status || 'pending') === 'pending' && !row.is_viewed ? 'border-primary' : 'border-gray-200 dark:border-gray-600'
                }`}
              >
                <div className="w-10 h-10 rounded-full overflow-hidden flex-shrink-0 bg-gradient-to-br from-orange-300 to-orange-400 flex items-center justify-center font-bold text-white">
                  {getFileUrl(row.user_avatar) ? <img src={getFileUrl(row.user_avatar)!} alt={row.user_name} className="w-full h-full object-cover" /> : row.user_name.charAt(0).toUpperCase()}
                </div>

                <div className="flex-1 min-w-0">
                  <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                    <span className="font-bold text-gray-800 dark:text-gray-100">{row.user_name}</span>
                    <span className="text-gray-400 text-sm">submitted</span>
                    <span className="font-semibold text-gray-800 dark:text-gray-100 truncate">{row.task_title}</span>
                    <span className={`material-icons text-sm ${row.task_type === 'mandatory' ? 'text-blue-500' : 'text-yellow-500'}`} title={row.task_type}>{row.task_type === 'mandatory' ? 'assignment' : 'stars'}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold uppercase ${chip(row.status)}`}>{row.status || 'pending'}</span>
                    {(row.status || 'pending') === 'pending' && !row.is_viewed && <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-700">NEW</span>}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                    <span className="material-icons text-sm align-middle mr-1">menu_book</span>
                    {row.lesson_title}
                    <span className="text-gray-300 dark:text-gray-600"> · </span>
                    {shortPhase(row.path_name)}
                    {row.course_name && <><span className="text-gray-300 dark:text-gray-600"> · </span>{row.course_name}</>}
                  </div>
                  {(row.comment || row.file_name) && (
                    <div className="mt-1.5 text-sm text-gray-700 dark:text-gray-300 flex items-start gap-3">
                      {row.comment && <span className="line-clamp-2 break-words">{row.comment}</span>}
                      {row.file_name && (
                        <span className="flex items-center gap-1 text-gray-500 whitespace-nowrap flex-shrink-0">
                          <span className="material-icons text-sm">insert_drive_file</span>{row.file_name}
                        </span>
                      )}
                    </div>
                  )}
                </div>

                <div className="flex flex-col items-end gap-2 flex-shrink-0">
                  <span className="text-xs text-gray-400 whitespace-nowrap">{when(row.submitted_at)}</span>
                  {link ? (
                    <span className="flex items-center text-sm font-bold text-primary-dark dark:text-primary opacity-70 group-hover:opacity-100">
                      Open lesson<span className="material-icons text-base ml-1">arrow_forward</span>
                    </span>
                  ) : (
                    <span className="text-xs text-gray-400 italic">phase not in a course</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* Infinite scroll sentinel / end marker */}
        <div ref={sentinelRef} className="h-1" />
        {loadingMore && (
          <div className="py-4 flex items-center justify-center gap-2 text-sm text-gray-400">
            <span className="material-icons animate-spin text-base">refresh</span>Loading more…
          </div>
        )}
        {!hasMore && loaded && rows.length > 0 && (
          <p className="py-4 text-center text-xs text-gray-400">That's all · {rows.length} shown</p>
        )}
        {hasMore && !loadingMore && (
          <div className="py-3 text-center">
            <button onClick={loadMore} className="text-sm font-bold text-primary-dark dark:text-primary hover:underline">Load older</button>
          </div>
        )}
      </div>
    </div>
  );
};
