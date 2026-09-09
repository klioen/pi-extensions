import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeTodoState, validateTodos } from "../packages/todo/lib/todo-core.cjs";
test("normalizes todo state",()=>{assert.deepEqual(normalizeTodoState({todos:[{id:"a",step:"Inspect",status:"pending"}]}),{todos:[{id:"a",step:"Inspect",status:"pending"}],explanation:undefined});});
test("validates todo transitions",()=>{assert.equal(validateTodos([{id:"a",step:"Inspect",status:"completed"}]).length,1);assert.throws(()=>validateTodos([{id:"a",step:"a",status:"in_progress"},{id:"b",step:"b",status:"in_progress"}]),/only one/);assert.throws(()=>validateTodos([{id:"a",step:"a",status:"blocked"}]),/explanation/);assert.throws(()=>validateTodos([{id:"a",step:"a",status:"pending"}],undefined,[{id:"a",step:"a",status:"completed"}]),/completed/);});
