import { NextRequest } from "next/server";
import OpenAI from "openai";
import { NegotiationSession } from "@/lib/agents";
import { runNegotiationStep } from "@/lib/server-negotiation";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENAI_API_KEY) {
      return Response.json(
        { ok: false, error: "OPENAI_API_KEY is not configured." },
        { status: 500 }
      );
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const body = (await req.json()) as { session: NegotiationSession };
    const session = await runNegotiationStep({ client, session: body.session });

    return Response.json({ ok: true, session });
  } catch (err: any) {
    return Response.json(
      { ok: false, error: err?.message ?? "Negotiation step failed." },
      { status: 500 }
    );
  }
}
