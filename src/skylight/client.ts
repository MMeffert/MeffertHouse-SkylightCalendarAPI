/**
 * Skylight Calendar API Client
 * Wraps the unofficial Skylight API for chore and category management
 */

import https from "https";
import {
  GetChoresResponse,
  GetCategoriesResponse,
  Chore,
  Category,
} from "./types.js";

const BASE_URL = "https://app.ourskylight.com";
const REQUEST_TIMEOUT_MS = 15000; // 15 seconds

export interface SkylightClientConfig {
  authToken: string;
  frameId: string;
}

export class SkylightClient {
  private authToken: string;
  private frameId: string;

  constructor(config: SkylightClientConfig) {
    this.authToken = config.authToken;
    this.frameId = config.frameId;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const bodyStr = body ? JSON.stringify(body) : "";

    const headers: Record<string, string> = {
      "Accept": "application/json",
      "Authorization": this.authToken,
      "User-Agent": "SkylightMobile/1.95.2 (ios 26.2)",
      "Accept-Language": "en-US,en;q=0.9",
    };

    if (body) {
      headers["Content-Type"] = "application/json; charset=utf-8";
      headers["Content-Length"] = Buffer.byteLength(bodyStr).toString();
    }

    return new Promise((resolve, reject) => {
      const req = https.request(
        `${BASE_URL}${path}`,
        {
          method,
          headers,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              resolve(JSON.parse(data) as T);
            } else {
              reject(new Error(`Skylight API error: ${res.statusCode} - ${data}`));
            }
          });
        }
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Skylight API timeout after ${REQUEST_TIMEOUT_MS}ms`));
      });
      req.on("error", reject);

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /**
   * Get chores for a date range
   * @param after Start date (YYYY-MM-DD)
   * @param before End date (YYYY-MM-DD)
   * @param includeLate Include overdue chores
   */
  async getChores(
    after: string,
    before: string,
    includeLate: boolean = true
  ): Promise<Chore[]> {
    const params = new URLSearchParams({
      after,
      before,
      include_late: String(includeLate),
    });

    const response = await this.request<GetChoresResponse>(
      "GET",
      `/api/frames/${this.frameId}/chores?${params}`
    );

    // Build a map of categories for quick lookup
    const categoryMap = new Map<string, string>();
    if (response.included) {
      for (const category of response.included) {
        if (category.type === "category") {
          categoryMap.set(category.id, category.attributes.label || "Unknown");
        }
      }
    }

    // Transform to simplified Chore type
    return response.data.map((chore) => {
      const categoryId = chore.relationships?.category?.data?.id || null;
      return {
        id: chore.id,
        summary: chore.attributes.summary,
        status: chore.attributes.status || "pending",
        date: chore.attributes.start,
        time: chore.attributes.start_time || null,
        recurring: chore.attributes.recurring,
        recurrence: chore.attributes.recurrence_set || null,
        categoryId,
        categoryLabel: categoryId ? categoryMap.get(categoryId) || null : null,
        completedOn: chore.attributes.completed_on || null,
      };
    });
  }

  /**
   * Create a new chore using the create_multiple endpoint (v1.95+ API)
   * Uses flat JSON format instead of JSON:API
   */
  async createChore(params: {
    summary: string;
    date: string;
    time?: string;
    categoryId?: string;
    recurring?: boolean;
    recurrenceRule?: string;
    emojiIcon?: string;
  }): Promise<Chore> {
    // The mobile app v1.95+ uses /create_multiple with flat JSON body
    const isRecurring = params.recurring || !!params.recurrenceRule;
    const requestBody: Record<string, unknown> = {
      summary: params.summary,
      start: params.date,
      routine: isRecurring,
      recurring: isRecurring,
      recurring_until: null,
      start_time: params.time || null,
      // recurrence_set must be an array of RRULE strings
      recurrence_set: params.recurrenceRule ? [params.recurrenceRule] : null,
      emoji_icon: params.emojiIcon || null,
      reward_points: null,
    };

    if (params.categoryId) {
      requestBody.category_id = params.categoryId;
      requestBody.category_ids = [params.categoryId];
    }

    // Response contains data array (even for single chore)
    const response = await this.request<{
      data: Array<{
        id: string;
        type: string;
        attributes: {
          summary: string;
          status: string;
          start: string;
          start_time: string | null;
          recurring: boolean;
          recurrence_set: string | null;
          completed_on: string | null;
        };
        relationships?: {
          category?: {
            data?: { id: string; type: string };
          };
        };
      }>;
      included?: Array<{
        id: string;
        type: string;
        attributes: { label?: string };
      }>;
    }>("POST", `/api/frames/${this.frameId}/chores/create_multiple`, requestBody);

    const chore = response.data[0];
    const categoryId = chore.relationships?.category?.data?.id || null;

    // Get category label from included data
    let categoryLabel: string | null = null;
    if (categoryId && response.included) {
      const category = response.included.find(
        (c) => c.type === "category" && c.id === categoryId
      );
      if (category) {
        categoryLabel = category.attributes.label || null;
      }
    }

    return {
      id: chore.id,
      summary: chore.attributes.summary,
      status: chore.attributes.status || "pending",
      date: chore.attributes.start,
      time: chore.attributes.start_time || null,
      recurring: chore.attributes.recurring,
      recurrence: chore.attributes.recurrence_set || null,
      categoryId,
      categoryLabel,
      completedOn: chore.attributes.completed_on || null,
    };
  }

  /**
   * Get all categories (family members)
   */
  async getCategories(): Promise<Category[]> {
    const response = await this.request<GetCategoriesResponse>(
      "GET",
      `/api/frames/${this.frameId}/categories`
    );

    return response.data.map((category) => ({
      id: category.id,
      label: category.attributes.label || "Unknown",
      color: category.attributes.color || null,
    }));
  }

  /**
   * Update an existing chore
   * Uses PUT with flat JSON body - only include fields being changed
   */
  async updateChore(
    choreId: string,
    updates: {
      summary?: string;
      date?: string;
      time?: string;
      categoryId?: string;
      status?: "pending" | "complete";
      emojiIcon?: string;
    }
  ): Promise<Chore> {
    const requestBody: Record<string, unknown> = {};

    if (updates.summary !== undefined) {
      requestBody.summary = updates.summary;
    }
    if (updates.date !== undefined) {
      requestBody.start = updates.date;
    }
    if (updates.time !== undefined) {
      requestBody.start_time = updates.time;
    }
    if (updates.categoryId !== undefined) {
      requestBody.category_id = updates.categoryId;
    }
    if (updates.status !== undefined) {
      requestBody.status = updates.status;
    }
    if (updates.emojiIcon !== undefined) {
      requestBody.emoji_icon = updates.emojiIcon;
    }

    const response = await this.request<{
      data: {
        id: string;
        type: string;
        attributes: {
          summary: string;
          status: string;
          start: string;
          start_time: string | null;
          recurring: boolean;
          recurrence_set: string | null;
          completed_on: string | null;
        };
        relationships?: {
          category?: {
            data?: { id: string; type: string };
          };
        };
      };
      included?: Array<{
        id: string;
        type: string;
        attributes: { label?: string };
      }>;
    }>("PUT", `/api/frames/${this.frameId}/chores/${choreId}`, requestBody);

    const categoryId = response.data.relationships?.category?.data?.id || null;
    let categoryLabel: string | null = null;
    if (categoryId && response.included) {
      const category = response.included.find(
        (c) => c.type === "category" && c.id === categoryId
      );
      if (category) {
        categoryLabel = category.attributes.label || null;
      }
    }

    return {
      id: response.data.id,
      summary: response.data.attributes.summary,
      status: response.data.attributes.status || "pending",
      date: response.data.attributes.start,
      time: response.data.attributes.start_time || null,
      recurring: response.data.attributes.recurring,
      recurrence: response.data.attributes.recurrence_set || null,
      categoryId,
      categoryLabel,
      completedOn: response.data.attributes.completed_on || null,
    };
  }

  /**
   * Mark a chore as complete
   * Uses PUT with flat JSON body (not JSON:API format)
   */
  async completeChore(choreId: string): Promise<Chore> {
    // PUT uses flat JSON, not JSON:API wrapper
    const response = await this.request<{
      data: {
        id: string;
        type: string;
        attributes: {
          summary: string;
          status: string;
          start: string;
          start_time: string | null;
          recurring: boolean;
          recurrence_set: string | null;
          completed_on: string | null;
        };
        relationships?: {
          category?: {
            data?: { id: string; type: string };
          };
        };
      };
    }>("PUT", `/api/frames/${this.frameId}/chores/${choreId}`, {
      status: "complete",
    });

    const categoryId = response.data.relationships?.category?.data?.id || null;

    return {
      id: response.data.id,
      summary: response.data.attributes.summary,
      status: response.data.attributes.status || "complete",
      date: response.data.attributes.start,
      time: response.data.attributes.start_time || null,
      recurring: response.data.attributes.recurring,
      recurrence: response.data.attributes.recurrence_set || null,
      categoryId,
      categoryLabel: null,
      completedOn: response.data.attributes.completed_on || null,
    };
  }

  /**
   * Delete a chore
   * @param choreId Chore ID (for recurring chores, may include date like "123-2026-01-15")
   * @param applyTo For recurring chores: "one" (this instance), "all" (entire series), "future" (this and future)
   */
  async deleteChore(choreId: string, applyTo?: "one" | "all" | "future"): Promise<void> {
    const query = applyTo ? `?apply_to=${applyTo}` : "";
    await this.request<void>(
      "DELETE",
      `/api/frames/${this.frameId}/chores/${choreId}${query}`
    );
  }
}
