import React, { useState, useEffect } from 'react';
import { apiUrl, getFileUrl } from '../config';
import { ConfirmDialog } from './ConfirmDialog';

interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'student';
  stars: number;
  avatar_url: string | null;
  is_approved: boolean;
  created_at: string;
  courses?: { id: number; name: string }[];
}

interface UsersAdminTableProps {
  currentUserId: number;
  highlightUserId?: number | null; // deep link /users?user=<id> (e.g. from a "new user" notification)
}

// Admin view of the Users page: every account with role, approval state, stars and enrolments.
export function UsersAdminTable({ currentUserId, highlightUserId = null }: UsersAdminTableProps) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);
  const [editForm, setEditForm] = useState({ name: '', email: '', role: 'student' as 'admin' | 'student', is_approved: false });
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ isOpen: boolean; userId?: number; userName?: string }>({ isOpen: false });
  const [addStarsDialog, setAddStarsDialog] = useState<{ isOpen: boolean; userId?: number; userName?: string }>({ isOpen: false });
  const [starsAmount, setStarsAmount] = useState<string>('10');

  useEffect(() => {
    fetchUsers();
  }, [highlightUserId]);

  // Scroll the deep-linked user into view once the table is there
  useEffect(() => {
    if (highlightUserId === null || users.length === 0) return;
    document.querySelector(`[data-user-row="${highlightUserId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }, [highlightUserId, users]);

  const fetchUsers = async () => {
    try {
      setLoading(true);
      const response = await fetch(apiUrl('/admin/users'), {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setUsers(data);
      }
    } catch (error) {
      console.error('Failed to fetch users:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleEdit = (user: User) => {
    setEditingUser(user);
    setEditForm({ name: user.name, email: user.email, role: user.role, is_approved: user.is_approved });
    setAvatarPreview(user.avatar_url ? getFileUrl(user.avatar_url) : null);
    setAvatarFile(null);
  };

  const handleAvatarChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      setAvatarFile(file);
      setAvatarPreview(URL.createObjectURL(file));
    }
  };

  const handleSave = async () => {
    if (!editingUser) return;

    try {
      const formData = new FormData();
      formData.append('name', editForm.name);
      formData.append('email', editForm.email);
      formData.append('role', editForm.role);
      formData.append('is_approved', editForm.is_approved.toString());
      
      if (avatarFile) {
        formData.append('avatar', avatarFile);
      }

      const response = await fetch(apiUrl(`/admin/users/${editingUser.id}`), {
        method: 'PUT',
        credentials: 'include',
        body: formData
      });

      if (response.ok) {
        await fetchUsers();
        setEditingUser(null);
        setAvatarFile(null);
        setAvatarPreview(null);
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to update user');
      }
    } catch (error) {
      console.error('Failed to update user:', error);
      alert('Failed to update user');
    }
  };

  const handleDelete = async (userId: number) => {
    try {
      const response = await fetch(apiUrl(`/admin/users/${userId}`), {
        method: 'DELETE',
        credentials: 'include'
      });

      if (response.ok) {
        await fetchUsers();
        setDeleteConfirm({ isOpen: false });
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to delete user');
      }
    } catch (error) {
      console.error('Failed to delete user:', error);
      alert('Failed to delete user');
    }
  };

  const handleAddStars = async (userId: number) => {
    const stars = parseInt(starsAmount);
    
    if (isNaN(stars) || stars <= 0) {
      alert('Please enter a valid number of stars (positive number)');
      return;
    }

    try {
      const response = await fetch(apiUrl(`/admin/users/${userId}/add-stars`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ stars })
      });

      if (response.ok) {
        await fetchUsers();
        setAddStarsDialog({ isOpen: false });
        setStarsAmount('10'); // Reset to default
      } else {
        const data = await response.json();
        alert(data.error || 'Failed to add stars');
      }
    } catch (error) {
      console.error('Failed to add stars:', error);
      alert('Failed to add stars');
    }
  };

  return (
    <>
      <div>
        <div>
          {/* Content */}
          <div>
            {loading ? (
              <div className="text-center py-8">
                <div className="inline-block animate-spin rounded-full h-12 w-12 border-b-2 border-primary"></div>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-gray-200 dark:border-gray-700">
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Avatar</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Name</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Email</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Role</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Stars</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Status</th>
                      <th className="text-left py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Courses</th>
                      <th className="text-right py-3 px-4 text-gray-600 dark:text-gray-300 font-semibold">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {users.map((user) => (
                      <tr key={user.id} data-user-row={user.id} className={`border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                        user.id === highlightUserId ? 'bg-primary/10 ring-2 ring-inset ring-primary' : ''}`}>
                        <td className="py-3 px-4">
                          <img
                            src={user.avatar_url ? getFileUrl(user.avatar_url)! : `https://ui-avatars.com/api/?name=${encodeURIComponent(user.name)}&background=random`}
                            alt={user.name}
                            className="w-10 h-10 rounded-full object-cover"
                          />
                        </td>
                        <td className="py-3 px-4 text-gray-800 dark:text-gray-200 font-medium">{user.name}</td>
                        <td className="py-3 px-4 text-gray-600 dark:text-gray-400">{user.email}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                            user.role === 'admin' ? 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-200' : 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-200'
                          }`}>
                            {user.role}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-gray-800 dark:text-gray-200">{user.stars}</td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-1 rounded-full text-xs font-semibold ${
                            user.is_approved ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-200' : 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-200'
                          }`}>
                            {user.is_approved ? 'Approved' : 'Pending'}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-sm text-gray-600 dark:text-gray-400">
                          {user.courses && user.courses.length > 0
                            ? user.courses.map((c) => c.name).join(', ')
                            : <span className="text-gray-300 dark:text-gray-600">—</span>}
                        </td>
                        <td className="py-3 px-4 text-right space-x-2">
                          <button
                            onClick={() => setAddStarsDialog({ isOpen: true, userId: user.id, userName: user.name })}
                            disabled={user.id === currentUserId}
                            className={`${
                              user.id === currentUserId
                                ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                : 'text-yellow-600 hover:text-yellow-700 dark:text-yellow-400 dark:hover:text-yellow-300'
                            } transition-colors`}
                            title={user.id === currentUserId ? 'Cannot give stars to yourself' : 'Add stars'}
                          >
                            <span className="material-icons text-xl">star</span>
                          </button>
                          <button
                            onClick={() => handleEdit(user)}
                            className="text-blue-600 hover:text-blue-700 dark:text-blue-400 dark:hover:text-blue-300 transition-colors"
                            title="Edit user"
                          >
                            <span className="material-icons text-xl">edit</span>
                          </button>
                          <button
                            onClick={() => setDeleteConfirm({ isOpen: true, userId: user.id, userName: user.name })}
                            disabled={user.id === currentUserId}
                            className={`${
                              user.id === currentUserId
                                ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                                : 'text-red-600 hover:text-red-700 dark:text-red-400 dark:hover:text-red-300'
                            } transition-colors`}
                            title={user.id === currentUserId ? 'Cannot delete yourself' : 'Delete user'}
                          >
                            <span className="material-icons text-xl">delete</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Edit Modal */}
      {editingUser && (
        <div className="fixed inset-0 bg-black/70 z-[160] flex items-center justify-center p-4" onClick={() => setEditingUser(null)}>
          <div 
            className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4">
              Edit User: {editingUser.name}
            </h3>

            <div className="space-y-4">
              {/* Avatar */}
              <div className="flex flex-col items-center">
                <img
                  src={avatarPreview || `https://ui-avatars.com/api/?name=${encodeURIComponent(editForm.name)}&background=random`}
                  alt="Avatar preview"
                  className="w-24 h-24 rounded-full object-cover mb-2"
                />
                <label className="cursor-pointer text-blue-600 hover:text-blue-700 dark:text-blue-400 text-sm">
                  Change Avatar
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleAvatarChange}
                    className="hidden"
                  />
                </label>
              </div>

              {/* Name */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Name</label>
                <input
                  type="text"
                  value={editForm.name}
                  onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                />
              </div>

              {/* Email */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Email</label>
                <input
                  type="email"
                  value={editForm.email}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                />
              </div>

              {/* Role */}
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Role</label>
                <select
                  value={editForm.role}
                  onChange={(e) => setEditForm({ ...editForm, role: e.target.value as 'admin' | 'student' })}
                  className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200"
                >
                  <option value="student">Student</option>
                  <option value="admin">Admin</option>
                </select>
              </div>

              {/* Approved */}
              <div className="flex items-center">
                <input
                  type="checkbox"
                  id="is_approved"
                  checked={editForm.is_approved}
                  onChange={(e) => setEditForm({ ...editForm, is_approved: e.target.checked })}
                  className="w-4 h-4 text-primary border-gray-300 rounded focus:ring-primary"
                />
                <label htmlFor="is_approved" className="ml-2 text-sm font-medium text-gray-700 dark:text-gray-300">
                  Approved
                </label>
              </div>
            </div>

            {/* Actions */}
            <div className="flex gap-3 mt-6">
              <button
                onClick={handleSave}
                className="flex-1 bg-primary hover:bg-primary-dark text-white font-semibold py-2 px-4 rounded-lg transition-colors"
              >
                Save Changes
              </button>
              <button
                onClick={() => setEditingUser(null)}
                className="flex-1 bg-gray-300 hover:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-800 dark:text-gray-200 font-semibold py-2 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add Stars Dialog */}
      {addStarsDialog.isOpen && (
        <div className="fixed inset-0 bg-black/70 z-[170] flex items-center justify-center p-4" onClick={() => setAddStarsDialog({ isOpen: false })}>
          <div 
            className="bg-white dark:bg-gray-800 rounded-2xl w-full max-w-md p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-xl font-bold text-gray-800 dark:text-gray-100 mb-4">
              ⭐ Add Stars to {addStarsDialog.userName}
            </h3>

            <div className="mb-6">
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                Number of stars to add:
              </label>
              <input
                type="number"
                min="1"
                value={starsAmount}
                onChange={(e) => setStarsAmount(e.target.value)}
                className="w-full px-4 py-3 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-800 dark:text-gray-200 text-center text-2xl font-bold"
                autoFocus
              />
              <p className="text-sm text-gray-500 dark:text-gray-400 mt-2 text-center">
                Are you sure you want to add <strong className="text-yellow-600">{starsAmount}</strong> star{parseInt(starsAmount) !== 1 ? 's' : ''} to {addStarsDialog.userName}?
              </p>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => addStarsDialog.userId && handleAddStars(addStarsDialog.userId)}
                className="flex-1 bg-yellow-500 hover:bg-yellow-600 text-white font-semibold py-3 px-4 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                <span className="material-icons">star</span>
                <span>Add Stars</span>
              </button>
              <button
                onClick={() => setAddStarsDialog({ isOpen: false })}
                className="flex-1 bg-gray-300 hover:bg-gray-400 dark:bg-gray-600 dark:hover:bg-gray-500 text-gray-800 dark:text-gray-200 font-semibold py-3 px-4 rounded-lg transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      <ConfirmDialog
        isOpen={deleteConfirm.isOpen}
        title="Delete User"
        message={`Are you sure you want to delete ${deleteConfirm.userName}? This action cannot be undone.`}
        variant="danger"
        onConfirm={() => deleteConfirm.userId && handleDelete(deleteConfirm.userId)}
        onCancel={() => setDeleteConfirm({ isOpen: false })}
      />
    </>
  );
}
