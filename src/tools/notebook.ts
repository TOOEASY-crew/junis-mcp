// src/tools/notebook.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "fs/promises";
import { execFile } from "child_process";
import { promisify } from "util";
import { enforcePolicy } from "../server/permissions.js";

const execFileAsync = promisify(execFile);

interface NotebookCell {
  cell_type: "code" | "markdown" | "raw";
  source: string | string[];  // nbformat spec allows both string and string[]
  metadata: Record<string, unknown>;
  outputs?: unknown[];
  execution_count?: number | null;
}

interface Notebook {
  cells: NotebookCell[];
  metadata: {
    kernelspec?: { name: string; display_name: string };
    language_info?: { name: string };
  };
  nbformat: number;
  nbformat_minor: number;
}

async function readNotebook(filePath: string): Promise<Notebook> {
  const raw = await fs.readFile(filePath, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`Invalid Jupyter notebook file: ${filePath}`);
  }
}

async function writeNotebook(filePath: string, nb: Notebook): Promise<void> {
  await fs.writeFile(filePath, JSON.stringify(nb, null, 1), "utf-8");
}

export class NotebookTools {
  register(server: McpServer): void {
    // notebook_read: list cells with their contents
    server.tool(
      "notebook_read",
      "Read a Jupyter notebook (.ipynb) and return all cells with their types (code/markdown), source content, and output counts. Use this to understand notebook structure before making edits.",
      { path: z.string().describe("Path to the .ipynb notebook file") },
      async ({ path: filePath }) => {
        enforcePolicy("notebook_read", { path: filePath });
        const nb = await readNotebook(filePath);
        const cells = nb.cells.map((cell, i) => ({
          index: i,
          type: cell.cell_type,
          source: Array.isArray(cell.source) ? cell.source.join("") : cell.source,
          outputs: cell.outputs?.length ?? 0,
        }));
        return {
          content: [{ type: "text", text: JSON.stringify(cells, null, 2) }],
        };
      }
    );

    // notebook_edit_cell: edit one cell
    server.tool(
      "notebook_edit_cell",
      "Replace the source code of a specific cell in a Jupyter notebook. Use notebook_read first to identify the correct cell index (0-based). Existing outputs for the cell are preserved — use notebook_execute to re-run.",
      {
        path: z.string().describe("Path to the .ipynb notebook file"),
        cell_index: z.number().describe("Cell index to edit (0-based). Use notebook_read to find the right index."),
        source: z.string().describe("New source code/content for the cell (replaces entire cell content)"),
      },
      async ({ path: filePath, cell_index, source }) => {
        enforcePolicy("notebook_edit_cell", { path: filePath });
        const nb = await readNotebook(filePath);
        if (cell_index < 0 || cell_index >= nb.cells.length) {
          throw new Error(`Invalid cell index: ${cell_index}`);
        }
        nb.cells[cell_index].source = source.split("\n").map((l, i, arr) =>
          i < arr.length - 1 ? l + "\n" : l
        );
        await writeNotebook(filePath, nb);
        return { content: [{ type: "text", text: "Cell updated" }] };
      }
    );

    // notebook_execute: run the notebook (via nbconvert)
    server.tool(
      "notebook_execute",
      [
        "Execute all cells in a Jupyter notebook using nbconvert. Results are saved in-place — the notebook file is updated with execution outputs.",
        "",
        "Requires Jupyter to be installed (pip install jupyter). The timeout applies per cell, not for the entire notebook.",
        "If execution fails on a cell, the error is captured in the cell output and subsequent cells may not execute.",
      ].join("\n"),
      {
        path: z.string().describe("Path to the .ipynb notebook file to execute"),
        timeout: z.number().optional().default(300).describe("Maximum execution time per cell in seconds (default: 300). Increase for cells with heavy computation."),
      },
      async ({ path: filePath, timeout }) => {
        enforcePolicy("notebook_execute", { path: filePath });
        const nbconvertArgs = ["nbconvert", "--to", "notebook", "--execute", "--inplace", filePath, `--ExecutePreprocessor.timeout=${timeout}`];

        // Commands to try, in priority order
        const candidates = [
          'jupyter',
          `${process.env.HOME}/Library/Python/3.9/bin/jupyter`,
          `${process.env.HOME}/Library/Python/3.10/bin/jupyter`,
          `${process.env.HOME}/Library/Python/3.11/bin/jupyter`,
          `${process.env.HOME}/Library/Python/3.12/bin/jupyter`,
          `${process.env.HOME}/Library/Python/3.13/bin/jupyter`,
          '/usr/local/bin/jupyter',
          '/opt/homebrew/bin/jupyter',
        ];

        for (const jupyter of candidates) {
          try {
            const { stdout, stderr } = await execFileAsync(jupyter, nbconvertArgs);
            return { content: [{ type: "text", text: stdout || stderr || "Execution complete" }] };
          } catch (err: unknown) {
            const error = err as NodeJS.ErrnoException;
            // Try the next candidate only when the binary is missing; throw immediately on a real execution error
            if (error.code !== 'ENOENT' && error.code !== 'EACCES') {
              throw err;
            }
          }
        }

        throw new Error('jupyter not found. Install it and try again: pip install jupyter');
      }
    );
    // notebook_add_cell: add a new cell
    server.tool(
      "notebook_add_cell",
      "Insert a new cell into a Jupyter notebook. If position is omitted, the cell is appended at the end. Use cell_type='code' for executable Python cells, 'markdown' for documentation/text cells.",
      {
        path: z.string().describe("Path to the .ipynb notebook file"),
        cell_type: z.enum(["code", "markdown"]).describe("'code' for executable cells, 'markdown' for text/documentation cells"),
        source: z.string().describe("Cell source content (Python code or Markdown text)"),
        position: z.number().optional().describe("Insert position (0-based index). Omit to append at the end. If position exceeds cell count, appends at end with a warning."),
      },
      async ({ path: filePath, cell_type: cellType, source, position }) => {
        enforcePolicy("notebook_add_cell", { path: filePath });
        const nb = await readNotebook(filePath);
        const newCell: NotebookCell = {
          cell_type: cellType,
          source: source.split("\n").map((l, i, arr) => i < arr.length - 1 ? l + "\n" : l),
          metadata: {},
          outputs: cellType === "code" ? [] : undefined,
          execution_count: cellType === "code" ? null : undefined,
        };
        let actualIndex: number;
        let warning = "";

        if (position === undefined || position === null) {
          nb.cells.push(newCell);
          actualIndex = nb.cells.length - 1;
        } else if (position > nb.cells.length) {
          // Out of range: append at the end, but warn the user
          nb.cells.push(newCell);
          actualIndex = nb.cells.length - 1;
          warning = ` (warning: position ${position} exceeded range, appended at end (index: ${actualIndex}))`;
        } else {
          const clamped = Math.max(0, position);
          nb.cells.splice(clamped, 0, newCell);
          actualIndex = clamped;
        }

        await writeNotebook(filePath, nb);
        return { content: [{ type: "text", text: `Cell added (index: ${actualIndex})${warning}` }] };
      }
    );

    // notebook_delete_cell: delete a cell
    server.tool(
      "notebook_delete_cell",
      "Delete a cell from a Jupyter notebook by its 0-based index. Use notebook_read first to verify the cell content before deletion. This action cannot be undone.",
      {
        path: z.string().describe("Path to the .ipynb notebook file"),
        cell_index: z.number().describe("Cell index to delete (0-based). Use notebook_read first to verify content."),
      },
      async ({ path: filePath, cell_index }) => {
        enforcePolicy("notebook_delete_cell", { path: filePath });
        const nb = await readNotebook(filePath);
        if (cell_index < 0 || cell_index >= nb.cells.length) {
          throw new Error(`Invalid cell index: ${cell_index}`);
        }
        nb.cells.splice(cell_index, 1);
        await writeNotebook(filePath, nb);
        return { content: [{ type: "text", text: `Cell deleted (index: ${cell_index})` }] };
      }
    );
  }
}
