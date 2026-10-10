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

// Quizzes and flashcard decks hanging under a lesson (prep material: no stars, no gating)
export type StudySetKind = 'quiz' | 'flashcards';

export interface StudyProgress {
  best_score: number;
  last_score: number;
  total: number;
  attempts: number;
}

// As listed on the road (GET /courses/:id): no items
export interface RoadStudySet {
  id: number;
  lesson_id: number;
  kind: StudySetKind;
  title: string;
  description: string;
  order_index: number;
  item_count: number;
  progress: StudyProgress | null;
}

// Quiz answers (`correct`, `explanation`) are only sent to admins; students get `multiple`.
export interface QuizItem {
  question: string;
  options: string[];
  correct?: number[];
  explanation?: string;
  multiple?: boolean;
}

export interface FlashcardItem {
  front: string;
  back: string;
}

// GET /study-sets/:id
export interface StudySet extends RoadStudySet {
  items: Array<QuizItem | FlashcardItem>;
  updated_at?: string;
}

export interface QuizResult {
  correct: boolean;
  selected: number[];
  correct_options: number[];
  explanation: string;
}

// Lesson materials (teacher-attached files). The content is read through /lesson-files/:id/*.
export interface LessonFile {
  id: number;
  lesson_id: number;
  name: string;
  ext: string;          // 'pdf' | 'txt' | 'md' | 'doc' | 'docx' | 'ppt' | 'pptx'
  size: number;         // bytes
  viewable: boolean;    // PDF / TXT / MD open in the app
  view_as: 'pdf' | 'text' | 'markdown' | null;
  order_index: number;
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
  taught_at?: string | null; // admin only: when the teacher marked the lesson as taught
  tasks: RoadTask[];
  study_sets?: RoadStudySet[];
  files?: LessonFile[];
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
