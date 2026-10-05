export interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'student';
  stars: number;
  rank?: number;
  avatar_url?: string;
}

// Shape returned by GET /api/paths (ids are serialised as strings by the API)
export interface Path {
  id: string;
  title: string;
  description: string;
  status: 'locked' | 'unlocked' | 'in-progress';
  requiredScore: number;
  course_id?: number | null;
  order_index?: number;
  requires_previous?: boolean;
}

// GET /api/courses
export interface Course {
  id: number;
  name: string;
  description: string;
  phaseCount: number;
  lessonCount: number;
  studentCount: number;
  enrolled: boolean;
  // Students only: mandatory tasks approved / total mandatory tasks
  progress: { total: number; done: number } | null;
}

// GET /api/courses/:id — the whole road
export interface RoadTask {
  id: number;
  lesson_id: number;
  title: string;
  description?: string;
  type: 'mandatory' | 'optional';
  xp_reward: number;
  deadline: string | null;
  order_index: number;
  position_x: number;
  position_y: number;
  completed: boolean;
  is_new?: boolean;
  unviewed_count?: number;
}

export interface RoadLesson {
  id: number;
  path_id: number;
  title: string;
  description?: string;
  order_index: number;
  position_x: number;
  position_y: number;
  completed: boolean;
  tasks: RoadTask[];
}

export type LockReason = 'enroll' | 'previous' | 'stars' | 'unpublished';

export interface Phase {
  id: number;
  name: string;
  description: string;
  order_index: number;
  stars_required: number;
  requires_previous: boolean;
  locked: boolean;
  lockReasons: LockReason[];
  lessons: RoadLesson[];
}

export interface CourseDetail {
  id: number;
  name: string;
  description: string;
  enrolled: boolean;
  phases: Phase[];
}

export interface DirectoryUser {
  id: number;
  name: string;
  role: 'admin' | 'student';
  stars: number;
  avatar_url?: string | null;
}

export interface Lesson {
  id: number;
  path_id: number;
  title: string;
  description: string;
  order_num: number;
}

export interface Task {
  id: number;
  lesson_id: number;
  title: string;
  description: string;
  order_num: number;
  type: 'mandatory' | 'optional';
  deadline: string | null;
  stars: number;
}

export interface CompletedTask {
  task_id: number;
  completed_at: string;
}

export interface OnlineUser {
  id: number;
  name: string;
  avatar_url?: string;
}

export interface Chat {
  id: number;
  name: string;
  created_by: number;
  created_at: string;
  updated_at: string;
  message_count: number;
  last_message: string | null;
  last_message_at: string | null;
}

export interface Message {
  id: number;
  chat_id: number;
  user_id: number;
  content: string;
  images?: string | null;
  created_at: string;
  user_name: string;
  user_avatar: string | null;
  user_role: 'admin' | 'student';
}

export interface ChatMember {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'student';
  avatar_url?: string;
  joined_at: string;
}
