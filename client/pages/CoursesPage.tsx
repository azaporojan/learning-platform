import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { Course, Path, User } from '../types';
import { apiUrl } from '../config';
import { useSocket } from '../contexts/SocketContext';
import { CourseModal } from '../components/CourseModal';
import { AddPathModal } from '../components/AddPathModal';
import { EditPathModal } from '../components/EditPathModal';
import { AlertDialog } from '../components/AlertDialog';
import { useDialog } from '../hooks/useDialog';

interface CoursesPageProps {
  mode: 'all' | 'mine';
  currentUser: User;
}

export const CoursesPage: React.FC<CoursesPageProps> = ({ mode, currentUser }) => {
  const navigate = useNavigate();
  const { socket } = useSocket();
  const { alertState, showAlert, hideAlert } = useDialog();
  const isAdmin = currentUser.role === 'admin';

  const [courses, setCourses] = useState<Course[]>([]);
  const [unassigned, setUnassigned] = useState<Path[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busyCourse, setBusyCourse] = useState<number | null>(null);
  const [courseModal, setCourseModal] = useState<{ open: boolean; course: Course | null }>({ open: false, course: null });
  const [addPhaseOpen, setAddPhaseOpen] = useState(false);
  const [editPhase, setEditPhase] = useState<Path | null>(null);

  const fetchAll = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/courses'), { credentials: 'include' });
      if (res.ok) setCourses(await res.json());
      if (isAdmin) {
        const pr = await fetch(apiUrl('/paths'), { credentials: 'include' });
        if (pr.ok) {
          const paths: Path[] = await pr.json();
          setUnassigned(paths.filter((p) => p.course_id === null || p.course_id === undefined));
        }
      }
    } catch (err) {
      console.error('Failed to fetch courses', err);
    } finally {
      setLoaded(true);
    }
  }, [isAdmin]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    if (!socket) return;
    const refresh = () => fetchAll();
    socket.on('course:updated', refresh);
    socket.on('task:completed', refresh);
    return () => {
      socket.off('course:updated', refresh);
      socket.off('task:completed', refresh);
    };
  }, [socket, fetchAll]);

  const toggleEnrol = async (course: Course) => {
    setBusyCourse(course.id);
    try {
      const res = await fetch(apiUrl(`/courses/${course.id}/enroll`), {
        method: course.enrolled ? 'DELETE' : 'POST',
        credentials: 'include'
      });
      if (res.ok) {
        await fetchAll();
        if (!course.enrolled) navigate(`/courses/${course.id}`);
      } else {
        const data = await res.json().catch(() => ({}));
        showAlert('Error', data.error || 'Could not update enrolment', 'danger');
      }
    } catch {
      showAlert('Error', 'Network error. Please try again.', 'danger');
    } finally {
      setBusyCourse(null);
    }
  };

  const visible = mode === 'mine' ? courses.filter((c) => c.enrolled) : courses;
  const title = mode === 'mine' ? 'My Courses' : isAdmin ? 'Courses' : 'All Courses';

  return (
    <div className="h-full overflow-y-auto custom-scrollbar">
      <AlertDialog isOpen={alertState.isOpen} title={alertState.title} message={alertState.message} variant={alertState.variant} onConfirm={hideAlert} />
      <CourseModal
        isOpen={courseModal.open}
        course={courseModal.course}
        onClose={() => setCourseModal({ open: false, course: null })}
        onSuccess={fetchAll}
      />
      {isAdmin && (
        <>
          <AddPathModal isOpen={addPhaseOpen} courses={courses} onClose={() => setAddPhaseOpen(false)} onSuccess={fetchAll} />
          <EditPathModal isOpen={!!editPhase} path={editPhase} courses={courses} onClose={() => setEditPhase(null)} onSuccess={fetchAll} />
        </>
      )}

      <div className="max-w-5xl mx-auto bg-card-light dark:bg-card-dark rounded-3xl border border-gray-200 dark:border-gray-700 p-6 sm:p-8 shadow-sm">
        <div className="flex items-center justify-between mb-8">
          <h2 className="text-3xl font-extrabold italic text-gray-700 dark:text-gray-200">{title}</h2>
          {isAdmin && (
            <button
              onClick={() => setCourseModal({ open: true, course: null })}
              className="flex items-center space-x-2 bg-primary hover:bg-primary-dark text-white font-bold px-4 py-2.5 rounded-xl shadow-md transition-colors"
            >
              <span className="material-icons">add</span>
              <span>New course</span>
            </button>
          )}
        </div>

        {loaded && visible.length === 0 && (
          <div className="text-center py-16 text-gray-500 dark:text-gray-400">
            <span className="material-icons text-6xl text-gray-300 dark:text-gray-600 mb-3">explore</span>
            {mode === 'mine' ? (
              <>
                <p className="text-lg font-semibold">You are not enrolled in any course yet.</p>
                <button onClick={() => navigate('/courses')} className="mt-4 text-primary-dark dark:text-primary font-bold hover:underline">
                  Browse all courses
                </button>
              </>
            ) : (
              <p className="text-lg font-semibold">{isAdmin ? 'No courses yet. Create the first one.' : 'No courses are published yet.'}</p>
            )}
          </div>
        )}

        <div className="space-y-5">
          {visible.map((course) => {
            const pct = course.progress && course.progress.total > 0 ? Math.round((course.progress.done / course.progress.total) * 100) : 0;
            return (
              <div
                key={course.id}
                onClick={() => navigate(`/courses/${course.id}`)}
                className="group relative bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all cursor-pointer overflow-hidden"
              >
                <div className={`absolute top-0 left-0 w-2 h-full transition-all group-hover:w-3 ${course.enrolled || isAdmin ? 'bg-primary' : 'bg-gray-300 dark:bg-gray-600'}`} />
                <div className="pl-3 flex flex-col md:flex-row md:items-center gap-4">
                  <div className="flex-1 min-w-0">
                    <h3 className="text-2xl font-bold italic text-gray-700 dark:text-gray-100 truncate">{course.name}</h3>
                    {course.description && <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 line-clamp-2">{course.description}</p>}
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-3 text-xs font-semibold text-gray-500 dark:text-gray-400">
                      <span className="flex items-center"><span className="material-icons text-base mr-1">flag</span>{course.phaseCount} phases</span>
                      <span className="flex items-center"><span className="material-icons text-base mr-1">menu_book</span>{course.lessonCount} lessons</span>
                      {isAdmin && <span className="flex items-center"><span className="material-icons text-base mr-1">group</span>{course.studentCount} enrolled</span>}
                      {course.enrolled && !isAdmin && (
                        <span className="bg-primary/20 text-primary-dark dark:text-primary rounded-full px-3 py-0.5 uppercase tracking-wide">Enrolled</span>
                      )}
                    </div>
                    {course.enrolled && course.progress && course.progress.total > 0 && (
                      <div className="mt-3 flex items-center gap-3">
                        <div className="flex-1 h-2 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                          <div className="h-full bg-gradient-to-r from-primary to-green-500 transition-all" style={{ width: `${pct}%` }} />
                        </div>
                        <span className="text-xs font-bold text-gray-600 dark:text-gray-300 whitespace-nowrap">{course.progress.done}/{course.progress.total} tasks · {pct}%</span>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                    {isAdmin ? (
                      <button
                        onClick={() => setCourseModal({ open: true, course })}
                        className="flex items-center space-x-2 bg-primary hover:bg-primary-dark text-white font-bold px-4 py-2 rounded-lg shadow-sm transition-all"
                      >
                        <span className="material-icons text-base">edit</span>
                        <span className="text-sm">Edit</span>
                      </button>
                    ) : course.enrolled ? (
                      <button
                        onClick={() => toggleEnrol(course)}
                        disabled={busyCourse === course.id}
                        className="text-sm font-bold text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 px-3 py-2 transition-colors disabled:opacity-50"
                      >
                        Leave
                      </button>
                    ) : (
                      <button
                        onClick={() => toggleEnrol(course)}
                        disabled={busyCourse === course.id}
                        className="flex items-center space-x-2 bg-amber-500 hover:bg-amber-600 text-white font-bold px-5 py-2.5 rounded-xl shadow-md transition-all disabled:opacity-50"
                      >
                        <span className="material-icons text-xl">how_to_reg</span>
                        <span>{busyCourse === course.id ? 'Enrolling…' : 'Enrol'}</span>
                      </button>
                    )}
                    <button
                      onClick={() => navigate(`/courses/${course.id}`)}
                      className="flex items-center text-gray-500 hover:text-primary-dark dark:text-gray-400 dark:hover:text-primary font-bold px-3 py-2 transition-colors"
                    >
                      <span className="text-sm">Open</span>
                      <span className="material-icons text-base ml-1">arrow_forward</span>
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* Admin: phases that belong to no course yet */}
        {isAdmin && (
          <div className="mt-10">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-bold text-gray-600 dark:text-gray-300">
                Unassigned phases <span className="text-sm font-semibold text-gray-400">({unassigned.length})</span>
              </h3>
              <button onClick={() => setAddPhaseOpen(true)} className="flex items-center text-sm font-bold text-primary-dark dark:text-primary hover:underline">
                <span className="material-icons text-base mr-1">add</span>New phase
              </button>
            </div>
            {unassigned.length === 0 ? (
              <p className="text-sm text-gray-400 italic">Every phase belongs to a course. New phases are created from a course page or here.</p>
            ) : (
              <div className="space-y-3">
                {unassigned.map((p) => (
                  <div key={p.id} className="flex items-center justify-between bg-gray-50 dark:bg-gray-800 border border-dashed border-gray-300 dark:border-gray-600 rounded-xl px-5 py-3">
                    <span className="font-semibold text-gray-700 dark:text-gray-200 truncate">{p.title}</span>
                    <button onClick={() => setEditPhase(p)} className="flex items-center text-sm font-bold text-primary-dark dark:text-primary hover:underline flex-shrink-0 ml-4">
                      <span className="material-icons text-base mr-1">edit</span>Assign / edit
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
