import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import { DirectoryUser, User } from '../types';
import { apiUrl, getFileUrl } from '../config';
import { useSocket } from '../contexts/SocketContext';
import { UsersAdminTable } from '../components/UsersAdminTable';

interface UsersPageProps {
  currentUser: User;
}

const gradients = [
  'from-blue-400 to-blue-500', 'from-purple-400 to-purple-500', 'from-pink-400 to-pink-500', 'from-green-400 to-green-500',
  'from-orange-400 to-orange-500', 'from-red-400 to-red-500', 'from-teal-400 to-teal-500', 'from-indigo-400 to-indigo-500'
];
const gradientFor = (name: string) => gradients[name.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % gradients.length];

export const RoleBadge: React.FC<{ role: 'admin' | 'student' }> = ({ role }) => (
  <span className={`px-2 py-0.5 rounded-full text-[0.65rem] font-bold uppercase tracking-wide ${
    role === 'admin'
      ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200'
      : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
  }`}>
    {role}
  </span>
);

// Everyone can open this page. Students get the directory (name, role, stars — the old
// leaderboard, no emails); admins get the full management table.
export const UsersPage: React.FC<UsersPageProps> = ({ currentUser }) => {
  const { socket } = useSocket();
  const [users, setUsers] = useState<DirectoryUser[]>([]);
  const isAdmin = currentUser.role === 'admin';
  const [searchParams] = useSearchParams();
  const highlightUserId = /^\d+$/.test(searchParams.get('user') || '') ? Number(searchParams.get('user')) : null;

  const fetchDirectory = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/users/directory'), { credentials: 'include' });
      if (res.ok) setUsers(await res.json());
    } catch (err) {
      console.error('Failed to fetch users', err);
    }
  }, []);

  useEffect(() => {
    if (!isAdmin) fetchDirectory();
  }, [isAdmin, fetchDirectory]);

  useEffect(() => {
    if (!socket || isAdmin) return;
    socket.on('leaderboard:update', fetchDirectory);
    return () => { socket.off('leaderboard:update', fetchDirectory); };
  }, [socket, isAdmin, fetchDirectory]);

  if (isAdmin) {
    return (
      <div className="h-full overflow-y-auto custom-scrollbar">
        <div className="max-w-6xl mx-auto bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 p-6 sm:p-8 shadow-sm">
          <h2 className="text-3xl font-extrabold italic text-gray-700 dark:text-gray-200 mb-6">Users</h2>
          <UsersAdminTable currentUserId={currentUser.id} highlightUserId={highlightUserId} />
        </div>
      </div>
    );
  }

  const admins = users.filter((u) => u.role === 'admin');
  const students = users.filter((u) => u.role === 'student');
  const rankOf = (id: number) => students.findIndex((s) => s.id === id) + 1;

  const Avatar: React.FC<{ user: DirectoryUser; ring?: string }> = ({ user, ring }) => (
    <div className={`w-12 h-12 rounded-full overflow-hidden shadow-md flex-shrink-0 ${ring || ''}`}>
      {getFileUrl(user.avatar_url) ? (
        <img src={getFileUrl(user.avatar_url)!} alt={user.name} className="w-full h-full object-cover" />
      ) : (
        <div className={`w-full h-full bg-gradient-to-br ${gradientFor(user.name)} flex items-center justify-center font-bold text-white text-lg`}>
          {user.name.charAt(0).toUpperCase()}
        </div>
      )}
    </div>
  );

  const medal = (rank: number) =>
    rank === 1 ? 'border-4 border-yellow-400' : rank === 2 ? 'border-4 border-gray-300' : rank === 3 ? 'border-4 border-orange-400' : '';

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <div className="max-w-5xl mx-auto bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 p-6 sm:p-8 shadow-sm">
        <h2 className="text-3xl font-extrabold italic text-gray-700 dark:text-gray-200 mb-8">Users</h2>

        <section className="mb-10">
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-400 mb-4">Students · leaderboard</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {students.map((u) => {
              const rank = rankOf(u.id);
              const me = u.id === currentUser.id;
              return (
                <div key={u.id} className={`flex items-center gap-4 rounded-2xl border px-4 py-3 bg-white dark:bg-gray-800 ${me ? 'border-primary ring-2 ring-primary/30' : 'border-gray-200 dark:border-gray-600'}`}>
                  <div className="w-8 text-center font-extrabold text-gray-400 italic">#{rank}</div>
                  <Avatar user={u} ring={medal(rank)} />
                  <div className="flex-1 min-w-0">
                    <div className="font-bold italic text-gray-800 dark:text-gray-100 truncate">{u.name}{me && <span className="ml-2 text-xs font-semibold text-primary-dark dark:text-primary">(you)</span>}</div>
                    <RoleBadge role={u.role} />
                  </div>
                  <div className="flex items-center font-bold text-gray-800 dark:text-gray-100 whitespace-nowrap">
                    {u.stars}<span className="material-icons ml-1 text-base text-yellow-400">stars</span>
                  </div>
                </div>
              );
            })}
            {students.length === 0 && <p className="text-sm text-gray-400 italic">No students yet.</p>}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-bold uppercase tracking-wide text-gray-400 mb-4">Administrators</h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {admins.map((u) => (
              <div key={u.id} className="flex items-center gap-4 rounded-2xl border border-gray-200 dark:border-gray-600 px-4 py-3 bg-white dark:bg-gray-800">
                <Avatar user={u} />
                <div className="flex-1 min-w-0">
                  <div className="font-bold italic text-gray-800 dark:text-gray-100 truncate">{u.name}</div>
                  <RoleBadge role={u.role} />
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
};
