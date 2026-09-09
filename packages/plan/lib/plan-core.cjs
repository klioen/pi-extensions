"use strict";
const PLAN_TOOLS=["read","grep","find","ls","bash"];
const SHELL_CONTROL=/[|;&><`\n\r]|\$\(|\$\{/;
function parsePlanArgs(input=""){const t=String(input).trim().split(/\s+/).filter(Boolean);if(!t.length)return{action:"on"};if(t.length===1&&["off","status"].includes(t[0]))return{action:t[0]};return{error:"usage: /plan [off|status]"};}
function isReadOnlyBashCommand(c){if(typeof c!=="string"||!c.trim()||SHELL_CONTROL.test(c))return false;const[a,...x]=c.trim().split(/\s+/);if(["cat","head","tail","wc","stat","file","pwd","ls","find","rg","grep","diff","du"].includes(a))return true;if(a==="sed")return x[0]==="-n";if(a==="node")return x.length===1&&x[0]==="--version";if(a==="git"){if(["status","log","diff","show","branch","remote","ls-files"].includes(x[0]))return true;return x[0]==="config"&&["--get","--get-regexp"].includes(x[1]);}return a==="npm"&&((x.length===1&&x[0]==="--version")||["list","ls","view","info","outdated","audit"].includes(x[0]));}
function normalizePlanState(v){if(!v||typeof v!=="object")return{enabled:false,toolsBeforePlanMode:undefined};const tools=Array.isArray(v.toolsBeforePlanMode)&&v.toolsBeforePlanMode.every(x=>typeof x==="string")?[...new Set(v.toolsBeforePlanMode)]:undefined;return{enabled:v.enabled===true,toolsBeforePlanMode:tools};}
function buildPlanPrompt(){return "CURRENT MODE: PLAN MODE. Collaborate on a plan, but do not execute it. Do not use todo_write in plan mode. A plan update is not implementation approval.";}
function buildNormalPrompt(){return "CURRENT MODE: NORMAL MODE. Plan mode is disabled. Do not claim that plan-mode restrictions apply; use the currently available tools normally.";}
module.exports={PLAN_TOOLS,parsePlanArgs,isReadOnlyBashCommand,normalizePlanState,buildPlanPrompt,buildNormalPrompt};
