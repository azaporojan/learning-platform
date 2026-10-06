import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { Navbar } from './components/Navbar';
import { RegisterModal } from './components/RegisterModal';
import { LoginModal } from './components/LoginModal';
import ChatWidget from './components/ChatWidget';
import { SocketProvider } from './contexts/SocketContext';
import { CoursesPage } from './pages/CoursesPage';
import { CoursePage } from './pages/CoursePage';
import { UsersPage } from './pages/UsersPage';
import { LessonScriptPage } from './pages/LessonScriptPage';
import { SubmissionsPage } from './pages/SubmissionsPage';
import { User } from './types';
import { apiUrl } from './config';

const App: React.FC = () => {
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [isLoginOpen, setIsLoginOpen] = useState(false);
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);

  // Check for saved user on app load (via API /me)
  useEffect(() => {
    const checkSession = async () => {
      try {
        const response = await fetch(apiUrl('/me'), { credentials: 'include' });
        if (response.ok) {
          const data = await response.json();
          setCurrentUser(data.user);
        }
        // Silently fail if not authenticated (401 is expected)
      } catch (error) {
        if (error instanceof Error) {
          console.error('Session check failed', error);
        }
      } finally {
        setSessionChecked(true);
      }
    };

    checkSession();
  }, []);

  const handleLoginSuccess = (user: User) => {
    setCurrentUser(user);
    setIsLoginOpen(false);
  };

  const handleLogout = async () => {
    try {
      await fetch(apiUrl('/logout'), { method: 'POST', credentials: 'include' });
      // Admin-only lesson-script drafts must not outlive the session on a shared machine
      try {
        Object.keys(localStorage).filter((k) => k.startsWith('lesson-script-draft-')).forEach((k) => localStorage.removeItem(k));
      } catch { /* ignore */ }
      setCurrentUser(null);
    } catch (error) {
      console.error('Logout failed', error);
    }
  };

  const authModals = (
    <>
      <RegisterModal
        isOpen={isRegisterOpen}
        onClose={() => setIsRegisterOpen(false)}
        onSwitchToLogin={() => {
          setIsRegisterOpen(false);
          setIsLoginOpen(true);
        }}
      />
      <LoginModal
        isOpen={isLoginOpen}
        onClose={() => setIsLoginOpen(false)}
        onLoginSuccess={handleLoginSuccess}
        onSwitchToRegister={() => {
          setIsLoginOpen(false);
          setIsRegisterOpen(true);
        }}
      />
    </>
  );

  // If not authenticated, show only login/register
  if (!currentUser) {
    return (
      <SocketProvider userId={null}>
        <div className="h-screen flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
          <Navbar
            onOpenRegister={() => setIsRegisterOpen(true)}
            onOpenLogin={() => setIsLoginOpen(true)}
            currentUser={null}
            onLogout={handleLogout}
            onUserUpdated={(u) => setCurrentUser(u)}
          />
          {authModals}

          {/* Welcome Screen - Force Login */}
          {sessionChecked && (
            <div className="flex-grow flex items-center justify-center p-4">
              <div className="text-center max-w-md">
                <h1 className="text-5xl font-extrabold italic text-gray-800 dark:text-gray-100 mb-4">
                  Welcome to Learning Platform
                </h1>
                <p className="text-xl text-gray-600 dark:text-gray-300 mb-8">
                  Please login or register to access your courses and track your progress.
                </p>
                <div className="flex gap-4 justify-center">
                  <button
                    onClick={() => setIsLoginOpen(true)}
                    className="px-8 py-3 bg-primary text-white font-bold rounded-full hover:bg-primary-dark transition-colors shadow-lg"
                  >
                    Login
                  </button>
                  <button
                    onClick={() => setIsRegisterOpen(true)}
                    className="px-8 py-3 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-100 font-bold rounded-full border-2 border-gray-300 dark:border-gray-600 hover:border-primary transition-colors shadow-lg"
                  >
                    Register
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </SocketProvider>
    );
  }

  const isAdmin = currentUser.role === 'admin';

  return (
    <SocketProvider userId={currentUser.id}>
      <div className="h-screen flex flex-col overflow-hidden">
        <Navbar
          onOpenRegister={() => setIsRegisterOpen(true)}
          onOpenLogin={() => setIsLoginOpen(true)}
          currentUser={currentUser}
          onLogout={handleLogout}
          onUserUpdated={(u) => setCurrentUser(u)}
        />
        {authModals}

        <main className="w-full px-4 sm:px-6 py-4 flex-grow overflow-hidden min-h-0">
          <Routes>
            <Route path="/" element={<Navigate to="/courses" replace />} />
            <Route path="/courses" element={<CoursesPage mode="all" currentUser={currentUser} />} />
            <Route
              path="/my-courses"
              element={isAdmin ? <Navigate to="/courses" replace /> : <CoursesPage mode="mine" currentUser={currentUser} />}
            />
            <Route path="/courses/:id" element={<CoursePage currentUser={currentUser} />} />
            <Route path="/courses/:courseId/lessons/:lessonId/script" element={<LessonScriptPage currentUser={currentUser} />} />
            <Route path="/users" element={<UsersPage currentUser={currentUser} />} />
            <Route path="/submissions" element={<SubmissionsPage currentUser={currentUser} />} />
            <Route path="*" element={<Navigate to="/courses" replace />} />
          </Routes>
        </main>

        <ChatWidget currentUserId={currentUser.id} userRole={currentUser.role} />
      </div>
    </SocketProvider>
  );
};

export default App;
