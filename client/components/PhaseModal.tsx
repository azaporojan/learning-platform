import React from 'react';
import { Phase } from '../types';
import { NodeStatus, shortPhaseName, lockReasonText } from '../roadState';

interface PhaseModalProps {
  phase: Phase | null;
  previous: Phase | null;
  status: NodeStatus;
  onClose: () => void;
  onJumpToFirstLesson?: () => void;
}

// Read-only phase summary for students: what the phase is about, how big it is and how to reach it.
export const PhaseModal: React.FC<PhaseModalProps> = ({ phase, previous, status, onClose, onJumpToFirstLesson }) => {
  if (!phase) return null;

  const tasks = phase.lessons.flatMap((l) => l.tasks);
  const mandatory = tasks.filter((t) => t.type === 'mandatory');
  const doneLessons = phase.lessons.filter((l) => l.completed).length;
  const doneMandatory = mandatory.filter((t) => t.completed).length;

  const statusChip = status === 'completed'
    ? { text: 'Completed', cls: 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300', icon: 'close' }
    : status === 'current'
      ? { text: 'You are here', cls: 'bg-primary/20 text-primary-dark dark:text-primary', icon: 'flag' }
      : status === 'locked'
        ? { text: 'Locked', cls: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400', icon: 'lock' }
        : { text: 'Open', cls: 'bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-200', icon: 'explore' };

  return (
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/50 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-2xl w-[720px] max-w-[95vw] max-h-[90vh] overflow-hidden flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <span className="px-2 py-0.5 rounded-md text-[11px] font-extrabold uppercase tracking-wide bg-primary/15 text-primary-dark dark:text-primary border border-primary/40">{shortPhaseName(phase)}</span>
              <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold ${statusChip.cls}`}>
                <span className="material-icons text-sm">{statusChip.icon}</span>{statusChip.text}
              </span>
            </div>
            <h3 className="text-2xl font-bold text-gray-800 dark:text-white">{phase.name}</h3>
          </div>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700 dark:hover:text-gray-300 flex-shrink-0">
            <span className="material-icons">close</span>
          </button>
        </div>

        <div className="flex-grow overflow-y-auto p-6 custom-scrollbar space-y-6">
          {phase.description ? (
            <div>
              <h4 className="text-sm font-bold text-gray-500 mb-2">PHASE SUMMARY</h4>
              <p className="text-gray-700 dark:text-gray-300 leading-relaxed whitespace-pre-wrap bg-gray-50 dark:bg-gray-900 p-4 rounded-lg">{phase.description}</p>
            </div>
          ) : (
            <p className="text-sm text-gray-400 italic">No summary for this phase yet.</p>
          )}

          <div className="grid grid-cols-3 gap-3">
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-center">
              <div className="text-2xl font-extrabold text-gray-800 dark:text-gray-100">{phase.lessons.length}</div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Lessons</div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-center">
              <div className="text-2xl font-extrabold text-gray-800 dark:text-gray-100">{mandatory.length}<span className="text-sm font-semibold text-gray-400"> / {tasks.length}</span></div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Mandatory / all tasks</div>
            </div>
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-center">
              <div className="text-2xl font-extrabold text-gray-800 dark:text-gray-100">{doneLessons}<span className="text-sm font-semibold text-gray-400"> / {phase.lessons.length}</span></div>
              <div className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Lessons done</div>
            </div>
          </div>

          <div>
            <h4 className="text-sm font-bold text-gray-500 mb-2">HOW TO REACH IT</h4>
            {phase.locked ? (
              <p className="flex items-start gap-2 text-sm text-gray-700 dark:text-gray-300">
                <span className="material-icons text-gray-400 text-base mt-0.5">lock</span>
                <span>{lockReasonText(phase, previous)}</span>
              </p>
            ) : (
              <ul className="text-sm text-gray-700 dark:text-gray-300 space-y-1">
                <li className="flex items-center gap-2"><span className="material-icons text-green-500 text-base">check_circle</span>This phase is open for you{mandatory.length > 0 ? ` · ${doneMandatory}/${mandatory.length} mandatory tasks approved` : ''}.</li>
                {phase.requires_previous && previous && <li className="flex items-center gap-2"><span className="material-icons text-gray-400 text-base">history</span>It needed {shortPhaseName(previous)} to be finished first.</li>}
                {phase.stars_required > 0 && <li className="flex items-center gap-2"><span className="material-icons text-yellow-400 text-base">stars</span>Needs {phase.stars_required} stars.</li>}
              </ul>
            )}
          </div>

          {phase.lessons.length > 0 && (
            <div>
              <h4 className="text-sm font-bold text-gray-500 mb-2">LESSONS</h4>
              <ol className="space-y-1">
                {phase.lessons.map((l, i) => (
                  <li key={l.id} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
                    <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-extrabold border ${l.completed ? 'bg-green-500 border-green-600 text-white' : 'bg-white dark:bg-gray-900 border-gray-300 dark:border-gray-600 text-gray-500'}`}>
                      {l.completed ? <span className="material-icons text-xs">close</span> : i + 1}
                    </span>
                    <span className={`truncate ${l.completed ? 'text-green-700 dark:text-green-300' : ''}`}>{l.title}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between bg-white dark:bg-gray-800">
          {onJumpToFirstLesson && phase.lessons.length > 0 ? (
            <button onClick={onJumpToFirstLesson} className="flex items-center text-sm font-bold text-primary-dark dark:text-primary hover:underline">
              <span className="material-icons text-base mr-1">my_location</span>Show on the road
            </button>
          ) : <div />}
          <button onClick={onClose} className="px-6 py-2.5 bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-gray-200 font-bold rounded-lg transition-colors">Close</button>
        </div>
      </div>
    </div>
  );
};
