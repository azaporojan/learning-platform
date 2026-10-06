import React, { useState, useRef, useEffect } from 'react';
import { NavLink, Link } from 'react-router-dom';
import { useDialog } from '../hooks/useDialog';
import { useOnlineUsers } from '../hooks/useOnlineUsers';
import { useSocket } from '../contexts/SocketContext';
import { AlertDialog } from './AlertDialog';
import { apiUrl, getFileUrl } from '../config';
import { NotificationDropdown } from './NotificationDropdown';
import ApiKeysModal from './ApiKeysModal';

interface NavbarProps {
  onOpenRegister?: () => void;
  onOpenLogin: () => void;
  currentUser: any;
  onLogout?: () => void;
  onUserUpdated?: (user: any) => void;
}

// Helper function for gradient colors
const getGradientForName = (name: string): string => {
  const gradients = [
    'from-blue-400 to-blue-500',
    'from-purple-400 to-purple-500',
    'from-pink-400 to-pink-500',
    'from-green-400 to-green-500',
    'from-orange-400 to-orange-500',
    'from-red-400 to-red-500',
    'from-teal-400 to-teal-500',
    'from-indigo-400 to-indigo-500'
  ];
  const hash = name.split('').reduce((acc, char) => acc + char.charCodeAt(0), 0);
  return gradients[hash % gradients.length];
};

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  `flex items-center px-4 py-2 rounded-xl text-sm font-bold transition-colors ${
    isActive
      ? 'bg-primary/20 text-primary-dark dark:text-primary'
      : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800'
  }`;

export const Navbar: React.FC<NavbarProps> = ({ onOpenRegister, onOpenLogin, currentUser, onLogout, onUserUpdated }) => {
  // Get online users from Socket.IO context
  const onlineUsers = useOnlineUsers();
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showApiKeysModal, setShowApiKeysModal] = useState(false);
  const [profileName, setProfileName] = useState('');
  const [selectedAvatarFile, setSelectedAvatarFile] = useState<File | null>(null);
  const [avatarPreviewUrl, setAvatarPreviewUrl] = useState<string | null>(null);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [savingProfile, setSavingProfile] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const avatarInputRef = useRef<HTMLInputElement>(null);

  const { alertState, showAlert, hideAlert } = useDialog();
  const { socket } = useSocket();
  const [pendingSubmissions, setPendingSubmissions] = useState(0);

  // Admin: number of submissions waiting for review (badge on the Submissions link), kept live
  useEffect(() => {
    if (!currentUser || currentUser.role !== 'admin') { setPendingSubmissions(0); return; }
    let cancelled = false;
    const refresh = async () => {
      try {
        const res = await fetch(apiUrl('/admin/submissions?status=pending&limit=1'), { credentials: 'include' });
        if (res.ok && !cancelled) setPendingSubmissions((await res.json()).counts.pending || 0);
      } catch { /* ignore */ }
    };
    refresh();
    if (!socket) return () => { cancelled = true; };
    const events = ['task:submission_uploaded', 'task:completed', 'task:deleted', 'lesson:deleted', 'course:updated'];
    events.forEach((e) => socket.on(e, refresh));
    return () => { cancelled = true; events.forEach((e) => socket.off(e, refresh)); };
  }, [socket, currentUser?.id, currentUser?.role]); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for live updates to current user (e.g. stars granted)
  useEffect(() => {
    if (!socket || !currentUser || !onUserUpdated) return;

    const handleTaskCompleted = async (data: { userId: number }) => {
      if (Number(data.userId) === Number(currentUser.id)) {
        try {
          const res = await fetch(apiUrl('/me'), { credentials: 'include' });
          if (res.ok) {
            const json = await res.json();
            onUserUpdated(json.user);
          }
        } catch (e) {
          console.error('[Navbar] Failed to refresh user data:', e);
        }
      }
    };

    const handleStarsUpdated = (data: { userId: number; stars: number }) => {
      if (Number(data.userId) === Number(currentUser.id)) {
        // Update user's stars immediately without refetching
        onUserUpdated({ ...currentUser, stars: data.stars });
      }
    };

    socket.on('task:completed', handleTaskCompleted);
    socket.on('user:stars_updated', handleStarsUpdated);

    return () => {
      socket.off('task:completed', handleTaskCompleted);
      socket.off('user:stars_updated', handleStarsUpdated);
    };
  }, [socket, currentUser, onUserUpdated]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setShowUserMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (!showProfileModal) return;
    setProfileName(currentUser?.name || '');
    setSelectedAvatarFile(null);
    setAvatarPreviewUrl(null);
    setAvatarError(null);
  }, [showProfileModal, currentUser]);

  useEffect(() => {
    if (!selectedAvatarFile) return;
    setAvatarError(null);
    const url = URL.createObjectURL(selectedAvatarFile);
    setAvatarPreviewUrl(url);
    // Validate image resolution to avoid pixelated avatars
    const img = new Image();
    img.onload = () => {
      const minSize = 256;
      if ((img.naturalWidth || 0) < minSize || (img.naturalHeight || 0) < minSize) {
        setAvatarError(`Imaginea este prea mică (${img.naturalWidth}x${img.naturalHeight}). Te rog încarcă una de minim ${minSize}x${minSize} pentru calitate bună.`);
      }
    };
    img.onerror = () => {
      setAvatarError('Nu am putut citi imaginea. Te rog încearcă alt fișier.');
    };
    img.src = url;
    return () => URL.revokeObjectURL(url);
  }, [selectedAvatarFile]);

  const handleSaveProfile = async () => {
    if (!currentUser) return;
    const name = profileName.trim();
    if (name.length < 2) return;
    if (avatarError) return;

    setSavingProfile(true);
    try {
      let avatarUrl = currentUser.avatar_url || null;

      if (selectedAvatarFile) {
        const formData = new FormData();
        formData.append('image', selectedAvatarFile);
        const uploadRes = await fetch(apiUrl('/upload-image'), {
          method: 'POST',
          credentials: 'include',
          body: formData
        });
        if (!uploadRes.ok) {
          throw new Error('Failed to upload avatar');
        }
        const uploadData = await uploadRes.json();
        avatarUrl = uploadData.url;
      }

      const res = await fetch(apiUrl('/me'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, avatar_url: avatarUrl })
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err?.error || 'Failed to update profile');
      }

      const data = await res.json();
      if (onUserUpdated) onUserUpdated(data.user);
      setShowProfileModal(false);
    } catch (e: any) {
      console.error(e);
      showAlert('Error', e?.message || 'Failed to update profile', 'danger');
    } finally {
      setSavingProfile(false);
    }
  };

  return (
    <>
      <AlertDialog
        isOpen={alertState.isOpen}
        title={alertState.title}
        message={alertState.message}
        variant={alertState.variant}
        onConfirm={hideAlert}
      />

      <nav className="bg-card-light dark:bg-card-dark border-b border-gray-200 dark:border-gray-700 px-6 py-3 flex justify-between items-center sticky top-0 z-50">
        <div className="flex items-center space-x-8">
          <Link to="/courses" className="text-3xl font-extrabold italic text-primary hover:text-primary-dark transition-colors">
            Learning
          </Link>

          {/* Primary navigation */}
          {currentUser && (
            <div className="hidden md:flex items-center space-x-1">
              <NavLink to="/courses" className={navLinkClass}>
                <span className="material-icons text-lg mr-1.5">map</span>
                {currentUser.role === 'admin' ? 'Courses' : 'All courses'}
              </NavLink>
              {currentUser.role !== 'admin' && (
                <NavLink to="/my-courses" className={navLinkClass}>
                  <span className="material-icons text-lg mr-1.5">school</span>
                  My courses
                </NavLink>
              )}
              <NavLink to="/users" className={navLinkClass}>
                <span className="material-icons text-lg mr-1.5">group</span>
                Users
              </NavLink>
              {currentUser.role === 'admin' && (
                <NavLink to="/submissions" className={navLinkClass}>
                  <span className="material-icons text-lg mr-1.5">inbox</span>
                  Submissions
                  {pendingSubmissions > 0 && (
                    <span className="ml-2 min-w-[20px] h-5 px-1.5 rounded-full bg-red-500 text-white text-[11px] font-bold flex items-center justify-center">{pendingSubmissions}</span>
                  )}
                </NavLink>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center space-x-6">
          {!currentUser ? (
            <button
              onClick={onOpenLogin}
              className="bg-primary hover:bg-primary-dark text-white px-5 py-2.5 rounded-xl font-bold text-sm shadow-md transition-colors"
            >
              Authentication
            </button>
          ) : (
            <div className="flex items-center space-x-6">
              {/* Online Users - exclude current user */}
              {onlineUsers.filter(u => u.id !== currentUser.id).length > 0 && (
                <div className="flex items-center space-x-3">
                  <span className="text-sm font-semibold text-gray-600 dark:text-gray-400">Online:</span>
                  <div className="flex items-center -space-x-2">
                    {onlineUsers.filter(u => u.id !== currentUser.id).slice(0, 8).map((user) => {
                      const initial = user.name.charAt(0).toUpperCase();
                      return (
                        <div
                          key={user.id}
                          className="relative group z-0 hover:z-20"
                          title={user.name}
                        >
                          <div className="w-7 h-7 rounded-full overflow-hidden border-2 border-green-500 shadow-sm transition-transform hover:scale-125 cursor-pointer bg-white">
                            {getFileUrl(user.avatar_url) ? (
                              <img src={getFileUrl(user.avatar_url)!} alt={user.name} className="w-full h-full object-cover" />
                            ) : (
                              <div className={`w-full h-full bg-gradient-to-br ${getGradientForName(user.name)} flex items-center justify-center font-bold text-white text-[0.65rem]`}>
                                {initial}
                              </div>
                            )}
                          </div>
                          {/* Tooltip */}
                          <div className="absolute top-full left-1/2 transform -translate-x-1/2 mt-2 px-2 py-1 bg-gray-900 text-white text-xs rounded whitespace-nowrap opacity-0 group-hover:opacity-100 transition-opacity pointer-events-none z-50">
                            {user.name}
                          </div>
                        </div>
                      );
                    })}
                    {onlineUsers.filter(u => u.id !== currentUser.id).length > 8 && (
                      <div className="w-7 h-7 rounded-full bg-gray-200 dark:bg-gray-700 border-2 border-gray-300 dark:border-gray-600 flex items-center justify-center font-bold text-gray-600 dark:text-gray-300 text-[0.55rem] shadow-sm">
                        +{onlineUsers.filter(u => u.id !== currentUser.id).length - 8}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Notification Bell */}
              <NotificationDropdown currentUser={currentUser} />

              {/* User Info with Dropdown */}
              <div className="relative" ref={menuRef}>
                <div
                  className="flex items-center space-x-3 border-l border-gray-300 dark:border-gray-600 pl-6 pr-3 py-1 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 transition-all"
                  onClick={() => setShowUserMenu(!showUserMenu)}
                >
                  {/* Avatar */}
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-orange-300 to-orange-400 flex items-center justify-center font-bold text-white text-base shadow-md overflow-hidden">
                    {getFileUrl(currentUser.avatar_url) ? (
                      <img src={getFileUrl(currentUser.avatar_url)!} alt="avatar" className="w-full h-full object-cover" />
                    ) : (
                      currentUser.name.charAt(0)
                    )}
                  </div>

                  {/* Name and Role/Stars */}
                  <div className="flex flex-col items-start leading-tight">
                    <span className="font-bold text-gray-900 dark:text-white text-base">{currentUser.name}</span>
                    {currentUser.role === 'admin' ? (
                      <span className="text-gray-500 dark:text-gray-400 text-xs">Administrator</span>
                    ) : (
                      <div className="flex items-center text-yellow-400 font-bold text-xs">
                        <span>{currentUser.stars || 0}</span>
                        <span className="material-icons text-sm ml-0.5">stars</span>
                      </div>
                    )}
                  </div>

                  {/* Dropdown Arrow */}
                  <span className={`material-icons text-gray-500 transition-transform ${showUserMenu ? 'rotate-180' : ''}`}>
                    expand_more
                  </span>
                </div>

                {/* Dropdown Menu */}
                {showUserMenu && (
                  <div className="absolute right-0 mt-2 w-56 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 py-2 z-50">
                    <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700">
                      <p className="text-sm font-bold text-gray-900 dark:text-white">{currentUser.name}</p>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">{currentUser.email}</p>
                    </div>

                    <button
                      className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                      onClick={() => {
                        setShowUserMenu(false);
                        setShowProfileModal(true);
                      }}
                    >
                      <span className="material-icons text-gray-600 dark:text-gray-400">person</span>
                      <span className="text-sm text-gray-700 dark:text-gray-300">Edit Profile</span>
                    </button>

                    {/* Small screens: the primary navigation lives in this menu */}
                    <div className="md:hidden border-b border-gray-200 dark:border-gray-700">
                      <Link to="/courses" onClick={() => setShowUserMenu(false)} className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                        <span className="material-icons text-gray-600 dark:text-gray-400">map</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">{currentUser.role === 'admin' ? 'Courses' : 'All courses'}</span>
                      </Link>
                      {currentUser.role !== 'admin' && (
                        <Link to="/my-courses" onClick={() => setShowUserMenu(false)} className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                          <span className="material-icons text-gray-600 dark:text-gray-400">school</span>
                          <span className="text-sm text-gray-700 dark:text-gray-300">My courses</span>
                        </Link>
                      )}
                      <Link to="/users" onClick={() => setShowUserMenu(false)} className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                        <span className="material-icons text-gray-600 dark:text-gray-400">group</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">Users</span>
                      </Link>
                      {currentUser.role === 'admin' && (
                        <Link to="/submissions" onClick={() => setShowUserMenu(false)} className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors">
                          <span className="material-icons text-gray-600 dark:text-gray-400">inbox</span>
                          <span className="text-sm text-gray-700 dark:text-gray-300">Submissions{pendingSubmissions > 0 ? ` (${pendingSubmissions})` : ''}</span>
                        </Link>
                      )}
                    </div>

                    {currentUser?.role === 'admin' && (
                      <button
                        className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                        onClick={() => {
                          setShowUserMenu(false);
                          setShowApiKeysModal(true);
                        }}
                      >
                        <span className="material-icons text-gray-600 dark:text-gray-400">key</span>
                        <span className="text-sm text-gray-700 dark:text-gray-300">API Keys</span>
                      </button>
                    )}

                    <button
                      className="w-full px-4 py-3 text-left flex items-center space-x-3 hover:bg-red-50 dark:hover:bg-red-900/20 transition-colors text-red-600"
                      onClick={() => {
                        setShowUserMenu(false);
                        if (onLogout) onLogout();
                      }}
                    >
                      <span className="material-icons">logout</span>
                      <span className="text-sm font-medium">Logout</span>
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </nav>

      {/* Edit Profile Modal */}
      {currentUser && showProfileModal && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={() => !savingProfile && setShowProfileModal(false)}>
          <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[560px] p-8 border border-gray-200 dark:border-gray-700" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <h3 className="text-2xl font-bold text-gray-900 dark:text-white">Edit Profile</h3>
              <button className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300" onClick={() => !savingProfile && setShowProfileModal(false)}>
                <span className="material-icons">close</span>
              </button>
            </div>

            <div className="flex items-center space-x-5 mb-6">
              <div className="relative">
                <div
                  className="w-20 h-20 rounded-full bg-gradient-to-br from-orange-300 to-orange-400 shadow-lg overflow-hidden flex items-center justify-center cursor-pointer border-2 border-white"
                  onClick={() => avatarInputRef.current?.click()}
                  title="Change photo"
                >
                  {(avatarPreviewUrl || getFileUrl(currentUser.avatar_url)) ? (
                    <img src={avatarPreviewUrl || getFileUrl(currentUser.avatar_url)!} alt="avatar" className="w-full h-full object-cover" />
                  ) : (
                    <span className="text-white font-extrabold text-2xl">{currentUser.name?.charAt(0)}</span>
                  )}
                </div>
                <button
                  className="absolute -bottom-2 -right-2 w-8 h-8 rounded-full bg-primary text-white flex items-center justify-center shadow-md hover:bg-primary-dark transition-colors"
                  onClick={() => avatarInputRef.current?.click()}
                  type="button"
                >
                  <span className="material-icons text-base">photo_camera</span>
                </button>
                <input
                  ref={avatarInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => setSelectedAvatarFile(e.target.files?.[0] || null)}
                />
              </div>

              <div className="flex-1">
                <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">Email</div>
                <div className="font-bold text-gray-800 dark:text-gray-200">{currentUser.email}</div>

                {currentUser.role !== 'admin' && (
                  <div className="mt-3 flex items-center text-yellow-400 font-bold">
                    <span className="mr-2">Stars:</span>
                    <span className="mr-1">{currentUser.stars || 0}</span>
                    <span className="material-icons text-base">stars</span>
                  </div>
                )}
              </div>
            </div>

            {avatarError && (
              <div className="mb-6 text-sm text-red-600 bg-red-50 border border-red-200 rounded-xl p-3">
                {avatarError}
              </div>
            )}

            <div className="mb-6">
              <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">Name</label>
              <input
                value={profileName}
                onChange={(e) => setProfileName(e.target.value)}
                className="w-full p-3 rounded-xl border border-gray-200 dark:border-gray-600 dark:bg-gray-700 outline-none focus:ring-2 focus:ring-primary"
                placeholder="Your name"
              />
              {profileName.trim().length > 0 && profileName.trim().length < 2 && (
                <div className="text-xs text-red-500 mt-2">Name must be at least 2 characters.</div>
              )}
            </div>

            <div className="flex justify-end space-x-3">
              <button
                className="px-5 py-2 rounded-lg text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 transition-colors"
                onClick={() => !savingProfile && setShowProfileModal(false)}
                type="button"
              >
                Cancel
              </button>
              <button
                className={`px-5 py-2 rounded-lg font-bold text-white transition-colors ${savingProfile || profileName.trim().length < 2 || !!avatarError ? 'bg-gray-400 cursor-not-allowed' : 'bg-primary hover:bg-primary-dark'}`}
                onClick={handleSaveProfile}
                disabled={savingProfile || profileName.trim().length < 2 || !!avatarError}
                type="button"
              >
                {savingProfile ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* API Keys Modal */}
      {currentUser && currentUser.role === 'admin' && (
        <ApiKeysModal
          isOpen={showApiKeysModal}
          onClose={() => setShowApiKeysModal(false)}
        />
      )}
    </>
  );
};