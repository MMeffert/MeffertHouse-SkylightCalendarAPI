/**
 * MCP Tools for Skylight Calendar
 * Defines the tools exposed to Claude for chore management
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SkylightClient } from "../skylight/client.js";

/**
 * Register all Skylight tools with the MCP server
 */
export function registerTools(server: McpServer, client: SkylightClient): void {
  // ─────────────────────────────────────────────────────────────
  // list_chores - List chores for a date range
  // ─────────────────────────────────────────────────────────────
  server.tool(
    "list_chores",
    "List chores from the Skylight Calendar for a date range. Returns all chores including who they're assigned to.",
    {
      after: z
        .string()
        .describe("Start date in YYYY-MM-DD format (e.g., 2025-01-12)"),
      before: z
        .string()
        .describe("End date in YYYY-MM-DD format (e.g., 2025-01-19)"),
      include_late: z
        .boolean()
        .optional()
        .default(true)
        .describe("Include overdue/late chores (default: true)"),
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

        // Format chores for readable output
        const choreList = chores
          .map((chore) => {
            const assignee = chore.categoryLabel || "Unassigned";
            const time = chore.time ? ` at ${chore.time}` : "";
            const status =
              chore.status === "completed" ? " [COMPLETED]" : "";
            const recurring = chore.recurring ? " (recurring)" : "";
            return `- ${chore.date}${time}: ${chore.summary} - ${assignee}${status}${recurring}`;
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
  server.tool(
    "create_chore",
    "Create a new chore on the Skylight Calendar. Optionally assign to a family member by category ID.",
    {
      summary: z.string().describe("The chore name/description"),
      date: z.string().describe("Date for the chore in YYYY-MM-DD format"),
      time: z
        .string()
        .optional()
        .describe("Time for the chore in HH:MM format (24-hour)"),
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
  server.tool(
    "complete_chore",
    "Mark a chore as completed on the Skylight Calendar.",
    {
      chore_id: z
        .string()
        .describe("The ID of the chore to mark as complete"),
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
  server.tool(
    "list_categories",
    "List all categories (family members) available for assigning chores. Use these IDs when creating chores.",
    {},
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
  server.tool(
    "delete_chore",
    "Delete a chore from the Skylight Calendar.",
    {
      chore_id: z
        .string()
        .describe("The ID of the chore to delete"),
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
}
