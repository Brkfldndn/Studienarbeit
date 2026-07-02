import { NextResponse } from "next/server";
import {
  listExperiments,
  requestExperimentCancel,
  summarize,
  updateManifest,
} from "@/lib/experiment-files";

export const runtime = "nodejs";

export async function POST(_req: Request, { params }: { params: { id: string } }) {
  try {
    const experiments = await listExperiments();
    const manifest = experiments.find((item) => item.id === params.id);

    if (!manifest) {
      return NextResponse.json({ ok: false, error: "Experiment not found." }, { status: 404 });
    }

    await requestExperimentCancel(params.id);

    if (manifest.status === "running") {
      const cancelled = {
        ...manifest,
        status: "cancelled" as const,
        completedAt: new Date().toISOString(),
        summary: manifest.summary || summarize([]),
        error: "Experiment cancellation requested.",
      };
      await updateManifest(cancelled);
      return NextResponse.json({ ok: true, manifest: cancelled });
    }

    return NextResponse.json({ ok: true, manifest });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err?.message || "Could not cancel experiment." }, { status: 500 });
  }
}
