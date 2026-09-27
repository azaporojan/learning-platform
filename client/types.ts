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
