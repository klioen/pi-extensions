import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import planCore from "../lib/plan-core.cjs";
const core = planCore as { PLAN_TOOLS: string[]; parsePlanArgs(a: string): { action?: "on" | "off" | "status"; error?: string }; isReadOnlyBashCommand(c: string): boolean; buildPlanPrompt(): string; normalizePlanState(v: unknown): { enabled: boolean; toolsBeforePlanMode?: string[] } };
const WRITE_TOOLS = new Set(["edit", "write"]);
export default function (pi: ExtensionAPI) {
 let enabled=false, previous: string[]|undefined;
 const ui=(ctx: ExtensionContext)=>ctx.ui.setStatus("pi-sdlc-plan",enabled?ctx.ui.theme.fg("warning","⏸ plan"):undefined);
 const save=()=>pi.appendEntry("pi-sdlc-plan",{enabled,toolsBeforePlanMode:previous});
 pi.registerCommand("plan",{description:"Enter read-only collaborative planning mode (/plan off | /plan status)",getArgumentCompletions:p=>["off","status"].filter(x=>x.startsWith(p)).map(value=>({value,label:value})),handler:async(args,ctx)=>{
  const parsed=core.parsePlanArgs(args); if(parsed.error)return ctx.ui.notify(parsed.error,"warning");
  if(parsed.action==="status")return ctx.ui.notify(`pi-sdlc: plan mode is ${enabled?"enabled":"disabled"}.`,"info");
  if(parsed.action==="off"){if(enabled){pi.setActiveTools(previous??pi.getActiveTools());enabled=false;previous=undefined;save();ui(ctx);}return ctx.ui.notify("pi-sdlc: plan mode disabled; this is not implementation approval.","info");}
  if(!ctx.isIdle())return ctx.ui.notify("pi-sdlc: /plan must be entered while idle.","warning");
  if(!enabled){previous=pi.getActiveTools();pi.setActiveTools(core.PLAN_TOOLS);enabled=true;save();ui(ctx);}ctx.ui.notify("pi-sdlc: plan mode enabled (read-only; /plan off exits).","info");
 }});
 pi.on("tool_call",async event=>{if(!enabled)return;if(WRITE_TOOLS.has(event.toolName))return {block:true,reason:"Plan mode is read-only. Use /plan off before implementation."};if(event.toolName==="bash"&&!core.isReadOnlyBashCommand(String(event.input.command??"")))return {block:true,reason:"Plan mode only permits one allowlisted read-only bash command."};if(!core.PLAN_TOOLS.includes(event.toolName))return {block:true,reason:`Plan mode blocks ${event.toolName}.`};});
 pi.on("before_agent_start",async()=>enabled?{message:{customType:"pi-sdlc-plan-context",content:core.buildPlanPrompt(),display:false}}:undefined);
 pi.on("session_start",async(_e,ctx)=>{const e=ctx.sessionManager.getEntries().filter((x:{type:string;customType?:string})=>x.type==="custom"&&x.customType==="pi-sdlc-plan").pop() as {data?:unknown}|undefined;const s=core.normalizePlanState(e?.data);enabled=s.enabled;previous=s.toolsBeforePlanMode;if(enabled)pi.setActiveTools(core.PLAN_TOOLS);ui(ctx);});
}
