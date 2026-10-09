import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSocket } from '../contexts/SocketContext';
import { ConfirmDeleteDialog } from './ConfirmDeleteDialog';
import { apiUrl } from '../config';

interface Notification {
  id: number;
  type: string;
  title: string;
  message: string;
  link: string | null;
  is_read: boolean;
  metadata: any;
  created_at: string;
  status?: 'pending' | 'approved' | 'rejected';
}

interface NotificationDropdownProps {
  currentUser: any;
}

export const NotificationDropdown: React.FC<NotificationDropdownProps> = ({ currentUser }) => {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const [loadingNotificationId, setLoadingNotificationId] = useState<number | null>(null);
  const [showDeleteAllDialog, setShowDeleteAllDialog] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const { socket } = useSocket();
  const navigate = useNavigate();

  // Every notification carries an in-app path (e.g. /courses/1?lesson=2&task=3); only
  // same-origin paths are followed.
  const isAppLink = (link: string | null): link is string => !!link && link.startsWith('/') && !link.startsWith('//');
  const open = (notification: Notification) => {
    if (!notification.is_read) markAsRead(notification.id);
    if (isAppLink(notification.link)) {
      setIsOpen(false);
      navigate(notification.link);
    }
  };

  // Fetch notifications
  const fetchNotifications = async () => {
    try {
      const response = await fetch(apiUrl('/notifications'), {
        credentials: 'include'
      });
      if (response.ok) {
        const data = await response.json();
        setNotifications(data);
        setUnreadCount(data.filter((n: Notification) => !n.is_read).length);
      }
    } catch (error) {
      console.error('Failed to fetch notifications:', error);
    }
  };

  useEffect(() => {
    if (currentUser) {
      fetchNotifications();
      // Poll every 30 seconds as backup
      const interval = setInterval(fetchNotifications, 30000);
      
      // Request browser notification permission
      if ('Notification' in window && Notification.permission === 'default') {
        Notification.requestPermission();
      }
      
      return () => clearInterval(interval);
    }
  }, [currentUser]);

  // Listen for new notifications via Socket.IO
  useEffect(() => {
    if (!socket || !currentUser) return;

    const handleNewNotification = (data: { userId: number; notification: Notification }) => {
      if (data.userId === currentUser.id) {
        // Add to top of list
        setNotifications(prev => [data.notification, ...prev]);
        setUnreadCount(prev => prev + 1);
        
        // Optional: Show browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
          const browserNotification = new Notification(data.notification.title, {
            body: data.notification.message,
            icon: '/favicon.ico'
          });
          browserNotification.onclick = () => {
            window.focus();
            if (isAppLink(data.notification.link)) navigate(data.notification.link);
            browserNotification.close();
          };
        }
      }
    };

    socket.on('new_notification', handleNewNotification);

    return () => {
      socket.off('new_notification', handleNewNotification);
    };
  }, [socket, currentUser, navigate]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Mark as read
  const markAsRead = async (notificationId: number) => {
    try {
      await fetch(apiUrl(`/notifications/${notificationId}/read`), {
        method: 'PUT',
        credentials: 'include'
      });
      fetchNotifications();
    } catch (error) {
      console.error('Failed to mark as read:', error);
    }
  };

  // Mark all as read
  const markAllAsRead = async () => {
    try {
      await fetch(apiUrl('/notifications/mark-all-read'), {
        method: 'PUT',
        credentials: 'include'
      });
      fetchNotifications();
    } catch (error) {
      console.error('Failed to mark all as read:', error);
    }
  };

  // Delete notification
  const deleteNotification = async (notificationId: number) => {
    try {
      await fetch(apiUrl(`/notifications/${notificationId}`), {
        method: 'DELETE',
        credentials: 'include'
      });
      
      // Remove from state
      setNotifications(prev => prev.filter(n => n.id !== notificationId));
      setUnreadCount(prev => Math.max(0, prev - 1));
    } catch (error) {
      console.error('Failed to delete notification:', error);
    }
  };

  // Delete all notifications
  const deleteAllNotifications = async () => {
    try {
      await fetch(apiUrl('/notifications'), {
        method: 'DELETE',
        credentials: 'include'
      });
      
      setNotifications([]);
      setUnreadCount(0);
      setShowDeleteAllDialog(false);
    } catch (error) {
      console.error('Failed to delete all notifications:', error);
    }
  };

  // Handle notification action (approve/reject for pending users)
  const handleAction = async (notificationId: number, action: 'approve' | 'reject', userId: number) => {
    setLoadingNotificationId(notificationId);
    try {
      const response = await fetch(apiUrl(`/users/${userId}/${action}`), {
        method: 'POST',
        credentials: 'include'
      });
      
      if (response.ok) {
        // Update the notification immediately in state
        setNotifications(prev => {
          const updated = prev.map(n => {
            if (n.id === notificationId) {
              const updatedNotification = {
                ...n,
                is_read: true,
                status: action === 'approve' ? 'approved' as const : 'rejected' as const
              };
              return updatedNotification;
            }
            return n;
          });
          // Update unread count
          setUnreadCount(updated.filter(n => !n.is_read).length);
          return updated;
        });
      }
    } catch (error) {
      console.error(`Failed to ${action} user:`, error);
    } finally {
      setLoadingNotificationId(null);
    }
  };

  const getNotificationIcon = (type: string) => {
    switch (type) {
      case 'account_approved': return '✅';
      case 'account_rejected': return '❌';
      case 'new_task': return '📝';
      case 'task_submission': return '📤';
      case 'task_graded': return '⭐';
      case 'submission_approved': return '✅';
      case 'submission_rejected': return '❌';
      case 'stars_received': return '⭐';
      case 'new_user_pending': return '👤';
      case 'role_changed': return '🛠️';
      default: return '🔔';
    }
  };

  const linkLabel = (n: Notification) => {
    switch (n.type) {
      case 'new_task': return 'Open the task';
      case 'task_submission': return 'Review the submission';
      case 'submission_approved':
      case 'submission_rejected': return 'Open the task';
      case 'new_user_pending': return 'Open in Users';
      case 'stars_received': return 'See the leaderboard';
      default: return 'Open';
    }
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);
    
    if (seconds < 60) return 'now';
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    if (seconds < 604800) return `${Math.floor(seconds / 86400)}d`;
    return date.toLocaleDateString('en-US');
  };

  return (
    <>
      <ConfirmDeleteDialog
        isOpen={showDeleteAllDialog}
        title="Delete All Notifications?"
        message="This action cannot be undone. All your notifications will be permanently deleted."
        onConfirm={deleteAllNotifications}
        onCancel={() => setShowDeleteAllDialog(false)}
      />
      
      <div className="relative" ref={dropdownRef}>
      {/* Bell Icon */}
      <button 
        className="relative text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors"
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="material-icons text-2xl">
          {unreadCount > 0 ? 'notifications_active' : 'notifications_none'}
        </span>
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 bg-red-500 text-white text-xs font-bold rounded-full w-5 h-5 flex items-center justify-center">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div className="absolute right-0 mt-2 w-96 bg-white dark:bg-gray-800 rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 z-50 max-h-[600px] flex flex-col">
          {/* Header */}
          <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-700 flex justify-between items-center">
            <h3 className="font-bold text-gray-900 dark:text-white">Notifications</h3>
            <div className="flex items-center space-x-2">
              {unreadCount > 0 && (
                <button 
                  className="text-xs text-primary hover:text-primary-dark font-semibold"
                  onClick={markAllAsRead}
                >
                  Mark all as read
                </button>
              )}
              {notifications.length > 0 && (
                <button 
                  className="text-xs text-red-500 hover:text-red-600 font-semibold"
                  onClick={() => setShowDeleteAllDialog(true)}
                >
                  Delete all
                </button>
              )}
            </div>
          </div>

          {/* Notifications List */}
          <div className="overflow-y-auto flex-1">
            {notifications.length === 0 ? (
              <div className="p-8 text-center text-gray-500 dark:text-gray-400">
                <span className="material-icons text-5xl mb-2 opacity-50">notifications_off</span>
                <p className="text-sm">No notifications</p>
              </div>
            ) : (
              notifications.map((notification) => (
                <div
                  key={notification.id}
                  className={`px-4 py-3 border-b border-gray-100 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors ${
                    isAppLink(notification.link) ? 'cursor-pointer' : ''
                  } ${!notification.is_read ? 'bg-blue-50 dark:bg-blue-900/10' : ''}`}
                  onClick={() => open(notification)}
                >
                  <div className="flex items-start space-x-3">
                    <span className="text-2xl flex-shrink-0">{getNotificationIcon(notification.type)}</span>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <p className="font-semibold text-sm text-gray-900 dark:text-white flex-1">
                          {notification.title}
                        </p>
                        <div className="flex items-center space-x-2 flex-shrink-0">
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {formatTimeAgo(notification.created_at)}
                          </span>
                          <button
                            className="text-gray-400 hover:text-red-500 transition-colors"
                            onClick={(e) => {
                              e.stopPropagation();
                              deleteNotification(notification.id);
                            }}
                            title="Delete notification"
                          >
                            <span className="material-icons text-base">close</span>
                          </button>
                        </div>
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-300 mt-1 whitespace-pre-line">
                        {notification.message}
                      </p>

                      {/* Action buttons for pending user approvals (admin only) */}
                      {notification.type === 'new_user_pending' && notification.metadata?.userId && notification.status === 'pending' && (
                        <div className="flex space-x-2 mt-3">
                          <button
                            className="flex-1 px-3 py-1.5 bg-green-500 hover:bg-green-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAction(notification.id, 'approve', notification.metadata.userId);
                            }}
                            disabled={loadingNotificationId === notification.id}
                          >
                            {loadingNotificationId === notification.id ? 'Processing...' : 'Approve'}
                          </button>
                          <button
                            className="flex-1 px-3 py-1.5 bg-red-500 hover:bg-red-600 text-white text-sm font-semibold rounded-lg transition-colors disabled:opacity-50"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleAction(notification.id, 'reject', notification.metadata.userId);
                            }}
                            disabled={loadingNotificationId === notification.id}
                          >
                            {loadingNotificationId === notification.id ? 'Processing...' : 'Reject'}
                          </button>
                        </div>
                      )}

                      {/* Show status if already handled */}
                      {notification.type === 'new_user_pending' && notification.status && notification.status !== 'pending' && (
                        <div className={`mt-3 px-3 py-1.5 rounded-lg text-sm font-semibold text-center ${
                          notification.status === 'approved' 
                            ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' 
                            : 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400'
                        }`}>
                          {notification.status === 'approved' ? '✓ Approved' : '✗ Rejected'}
                        </div>
                      )}

                      {/* The whole item opens the link; this is the visible hint */}
                      {isAppLink(notification.link) && (
                        <span className="text-xs text-primary-dark dark:text-primary font-semibold mt-2 inline-flex items-center">
                          {linkLabel(notification)}<span className="material-icons text-sm ml-0.5">arrow_forward</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
    </>
  );
};
