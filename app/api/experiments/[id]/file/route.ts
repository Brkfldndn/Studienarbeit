import { NextResponse } from "next/server";
import { readExperimentFile } from "@/lib/experiment-files";

export const runtime = "nodejs";

const contentTypes: Record<string, string> = {
  "summary.csv": "text/csv; charset=utf-8",
  "manifest.json": "application/json; charset=utf-8",
  "config.json": "application/json; charset=utf-8",
  "episodes.jsonl": "application/x-ndjson; charset=utf-8",
  "messages.jsonl": "application/x-ndjson; charset=utf-8",
  "model_calls.jsonl": "application/x-ndjson; charset=utf-8",
};

export async function GET(req: Request, { params }: { params: { id: string } }) {
  try {
    const url = new URL(req.url);
    const file = url.searchParams.get("file") || "summary.csv";
    const body = await readExperimentFile(params.id, file);

    return new NextResponse(body, {
      headers: {
        "content-type": contentTypes[file] || "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="${file}"`,
      },
    });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Experiment file not found." }, { status: 404 });
  }
}
