import React from 'react';
import { Path } from '../types';

interface PathCardProps {
  path: Path;
  onUnlock?: (pathId: string) => void;
  isAdmin?: boolean;
  onEdit?: (path: Path) => void;
}

export const PathCard: React.FC<PathCardProps> = ({ path, onUnlock, isAdmin, onEdit }) => {
  if (path.status === 'in-progress') {
    return (
      <div className="group bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-2xl p-6 shadow-sm hover:shadow-md transition-all cursor-pointer relative overflow-hidden h-32 flex items-center">
        <div className="absolute top-0 left-0 w-2 h-full bg-primary group-hover:w-3 transition-all"></div>
        <div className="flex items-center justify-between w-full pl-2">
          <h3 className="text-2xl sm:text-3xl font-bold italic text-gray-600 dark:text-gray-200">
            {path.title}
          </h3>
          
          {isAdmin ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (onEdit) onEdit(path);
              }}
              className="flex items-center space-x-2 bg-primary hover:bg-primary-dark text-white font-bold px-4 py-2 rounded-lg shadow-sm hover:shadow-md transition-all transform hover:scale-105 ml-2"
            >
              <span className="material-icons text-base">edit</span>
              <span className="text-sm">Edit</span>
            </button>
          ) : (
          <span className="bg-primary/20 text-primary-dark dark:text-primary rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wide whitespace-nowrap ml-2">
            In Progress
          </span>
          )}
        </div>
      </div>
    );
  }

  // Unlocked (can be unlocked by user) - only for students
  if (path.status === 'unlocked' && !isAdmin) {
    return (
      <div className="group bg-gradient-to-br from-yellow-100 to-yellow-100 dark:from-yellow-900/20 dark:to-yellow-900/20 border-2 border-yellow-300 dark:border-yellow-500 rounded-2xl p-6 shadow-sm hover:shadow-lg transition-all cursor-pointer relative h-32 flex items-center overflow-hidden">
        <div className="flex items-center justify-between w-full relative z-10">
          <div className="flex-1">
            <h3 className="text-2xl sm:text-3xl font-bold italic text-gray-800 dark:text-gray-200 mb-1">
              {path.title}
            </h3>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Ready to unlock!
            </p>
          </div>
          
          <button
            onClick={(e) => {
              e.stopPropagation();
              if (onUnlock) onUnlock(path.id);
            }}
            className="flex items-center space-x-2 bg-amber-500 hover:bg-amber-600 text-white font-bold px-6 py-3 rounded-xl shadow-md hover:shadow-lg transition-all transform hover:scale-105"
          >
            <span className="material-icons text-xl">lock_open</span>
            <span>Unlock</span>
          </button>
        </div>
      </div>
    );
  }

  // Locked State (not enough stars) - only for students
  return (
    <div className="bg-gray-100 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-2xl p-6 shadow-inner relative select-none h-32 flex items-center overflow-hidden">
      <div className="flex items-center justify-between w-full relative z-10">
        <h3 className="text-2xl sm:text-3xl font-bold italic text-gray-500 dark:text-gray-400">
          {path.title}
        </h3>
        {path.requiredScore && !isAdmin && (
          <div className="flex items-center font-bold text-gray-800 dark:text-gray-300">
            <span className="text-xl italic mr-1">{path.requiredScore}</span>
            <span className="material-icons text-yellow-400">stars</span>
          </div>
        )}
      </div>
      
      {/* Background Lock Icon Overlay */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <span className="material-icons text-red-200 dark:text-red-900/30 text-8xl opacity-50 transform rotate-12">
          lock
        </span>
      </div>
    </div>
  );
};