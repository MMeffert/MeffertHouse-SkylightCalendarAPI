/**
 * MCP Tools for Skylight Calendar
 * Defines the tools exposed to Claude for chore management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightClient } from "../skylight/client.js";

// Reusable date schema with format validation
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");
const timeSchema = z.string().regex(/^\d{2}:\d{2}$/, "Time must be HH:MM format").optional();

/**
 * Register all Skylight tools with the MCP server
 * Uses the new registerTool API to avoid deprecation warnings
 */
export function registerTools(server: McpServer, client: SkylightClient): void {
  // ─────────────────────────────────────────────────────────────
  // list_chores - List chores for a date range
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_chores",
    {
      description: "List chores from the Skylight Calendar for a date range. Returns all chores including who they're assigned to.",
      inputSchema: {
        after: dateSchema.describe("Start date (YYYY-MM-DD)"),
        before: dateSchema.describe("End date (YYYY-MM-DD)"),
        include_late: z
          .boolean()
          .optional()
          .default(true)
          .describe("Include overdue/late chores (default: true)"),
      },
    },
    async ({ after, before, include_late }) => {
      try {
        const chores = await client.getChores(after, before, include_late);

        if (chores.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `No chores found between ${after} and ${before}.`,
              },
            ],
          };
        }

        // Format chores for readable output (include ID for update/delete operations)
        const choreList = chores
          .map((chore) => {
            const assignee = chore.categoryLabel || "Unassigned";
            const time = chore.time ? ` at ${chore.time}` : "";
            const status = chore.status === "complete" ? " [DONE]" : "";
            const recurring = chore.recurring ? " (recurring)" : "";
            return `- [${chore.id}] ${chore.date}${time}: ${chore.summary} - ${assignee}${status}${recurring}`;
          })
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Found ${chores.length} chores between ${after} and ${before}:\n\n${choreList}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching chores: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // create_chore - Create a new chore
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "create_chore",
    {
      description: "Create a new chore on the Skylight Calendar. Optionally assign to a family member by category ID.",
      inputSchema: {
        summary: z.string().describe("The chore name/description"),
        date: dateSchema.describe("Date for the chore (YYYY-MM-DD)"),
        time: timeSchema.describe("Time for the chore (HH:MM, 24-hour)"),
        category_id: z
          .string()
          .optional()
          .describe(
            "Category/family member ID to assign the chore to. Use list_categories to see available IDs."
          ),
        recurring: z
          .boolean()
          .optional()
          .default(false)
          .describe("Whether this is a recurring chore"),
      },
    },
    async ({ summary, date, time, category_id, recurring }) => {
      try {
        const chore = await client.createChore({
          summary,
          date,
          time,
          categoryId: category_id,
          recurring,
        });

        const assignee = chore.categoryLabel || "Unassigned";
        const timeStr = chore.time ? ` at ${chore.time}` : "";

        return {
          content: [
            {
              type: "text" as const,
              text: `Created chore: "${chore.summary}" on ${chore.date}${timeStr}, assigned to ${assignee}. Chore ID: ${chore.id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error creating chore: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // complete_chore - Mark a chore as complete
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "complete_chore",
    {
      description: "Mark a chore as completed on the Skylight Calendar.",
      inputSchema: {
        chore_id: z
          .string()
          .describe("The ID of the chore to mark as complete"),
      },
    },
    async ({ chore_id }) => {
      try {
        const chore = await client.completeChore(chore_id);

        return {
          content: [
            {
              type: "text" as const,
              text: `Marked chore "${chore.summary}" as completed.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error completing chore: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // list_categories - List family members/categories
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "list_categories",
    {
      description: "List all categories (family members) available for assigning chores. Use these IDs when creating chores.",
      inputSchema: {},
    },
    async () => {
      try {
        const categories = await client.getCategories();

        if (categories.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: "No categories/family members found.",
              },
            ],
          };
        }

        const categoryList = categories
          .map((cat) => `- ${cat.label} (ID: ${cat.id})`)
          .join("\n");

        return {
          content: [
            {
              type: "text" as const,
              text: `Available categories/family members:\n\n${categoryList}\n\nUse these IDs with the create_chore tool to assign chores.`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error fetching categories: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // delete_chore - Delete a chore
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "delete_chore",
    {
      description: "Delete a chore from the Skylight Calendar.",
      inputSchema: {
        chore_id: z
          .string()
          .describe("The ID of the chore to delete"),
      },
    },
    async ({ chore_id }) => {
      try {
        await client.deleteChore(chore_id);

        return {
          content: [
            {
              type: "text" as const,
              text: `Deleted chore with ID: ${chore_id}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error deleting chore: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ─────────────────────────────────────────────────────────────
  // update_chore - Update an existing chore
  // ─────────────────────────────────────────────────────────────
  server.registerTool(
    "update_chore",
    {
      description: "Update an existing chore on the Skylight Calendar. Only include fields you want to change.",
      inputSchema: {
        chore_id: z.string().describe("The ID of the chore to update"),
        summary: z.string().optional().describe("New name/description for the chore"),
        date: dateSchema.optional().describe("New date (YYYY-MM-DD)"),
        time: timeSchema.describe("New time (HH:MM, 24-hour)"),
        category_id: z
          .string()
          .optional()
          .describe("New category/family member ID or name to reassign the chore"),
        status: z
          .enum(["pending", "complete"])
          .optional()
          .describe("Change status (use 'pending' to un-complete a chore)"),
        emoji_icon: z.string().optional().describe("Emoji icon for the chore (helps young kids)"),
      },
    },
    async ({ chore_id, summary, date, time, category_id, status, emoji_icon }) => {
      try {
        const chore = await client.updateChore(chore_id, {
          summary,
          date,
          time,
          categoryId: category_id,
          status,
          emojiIcon: emoji_icon,
        });

        const changes: string[] = [];
        if (summary) changes.push(`name to "${summary}"`);
        if (date) changes.push(`date to ${date}`);
        if (time) changes.push(`time to ${time}`);
        if (category_id) changes.push(`assignee to ${chore.categoryLabel || category_id}`);
        if (emoji_icon) changes.push(`icon to ${emoji_icon}`);
        if (status) changes.push(`status to ${status}`);

        return {
          content: [
            {
              type: "text" as const,
              text: `Updated chore: changed ${changes.join(", ")}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Error updating chore: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
