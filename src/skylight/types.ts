/**
 * Skylight Calendar API Types
 * Based on the unofficial reverse-engineered OpenAPI spec
 * https://github.com/MightyBandito/Skylight
 */

// JSON:API resource identifier
export interface ResourceId {
  type: string;
  id: string;
}

// ─────────────────────────────────────────────────────────────
// Categories (family members assigned to chores)
// ─────────────────────────────────────────────────────────────

export interface CategoryAttributes {
  color: string | null;
  selected_for_chore_chart: boolean | null;
  linked_to_profile: boolean | null;
  label: string | null;
  profile_pic_url: string | null;
}

export interface CategoryResource {
  type: "category";
  id: string;
  attributes: CategoryAttributes;
}

// ─────────────────────────────────────────────────────────────
// Chores
// ─────────────────────────────────────────────────────────────

export interface ChoreAttributes {
  id?: number | null;
  summary: string;
  status?: string; // 'pending', 'completed'
  start: string; // YYYY-MM-DD
  start_time?: string | null; // HH:MM
  completed_on?: string | null;
  is_future?: boolean | null;
  recurring: boolean;
  recurring_until?: string | null;
  recurrence_set?: string | null; // RRULE format
  reward_points?: number | null;
  emoji_icon?: string | null;
  routine?: boolean | null;
  position?: number | null;
}

export interface ChoreRelationships {
  category?: {
    data: ResourceId | null;
  };
}

export interface ChoreResource {
  type: "chore";
  id: string;
  attributes: ChoreAttributes;
  relationships?: ChoreRelationships;
}

// ─────────────────────────────────────────────────────────────
// API Request/Response Types
// ─────────────────────────────────────────────────────────────

export interface GetChoresResponse {
  data: ChoreResource[];
  included?: CategoryResource[];
}

export interface CreateChoreRequest {
  data: {
    type: "chore";
    attributes: ChoreAttributes;
    relationships?: ChoreRelationships;
  };
}

export interface CreateChoreResponse {
  data: ChoreResource;
  included?: CategoryResource[];
}

export interface GetCategoriesResponse {
  data: CategoryResource[];
}

// ─────────────────────────────────────────────────────────────
// Simplified types for MCP tool responses
// ─────────────────────────────────────────────────────────────

export interface Chore {
  id: string;
  summary: string;
  status: string;
  date: string;
  time: string | null;
  recurring: boolean;
  recurrence: string | null;
  categoryId: string | null;
  categoryLabel: string | null;
  completedOn: string | null;
}

export interface Category {
  id: string;
  label: string;
  color: string | null;
}
