import { useCallback, useEffect, useRef, useState } from "react";
import { ChatRuntime, type ChatRuntimeOptions } from "./runtime";
import type { ChatState } from "./types";

function copyState(state: ChatState): ChatState {
  return { ...state, messages: [...state.messages], pendingRequests: new Map(state.pendingRequests) };
}

export function useChatRuntime(options: Omit<ChatRuntimeOptions, "onChange"> = {}) {
  const optionsRef = useRef(options);
  const runtimeRef = useRef<ChatRuntime | null>(null);
  if (!runtimeRef.current) runtimeRef.current = new ChatRuntime(optionsRef.current);
  const [state, setState] = useState<ChatState>(() => copyState(runtimeRef.current!.state));

  useEffect(() => {
    let runtime = runtimeRef.current;
    if (!runtime || runtime.destroyed) {
      runtime = new ChatRuntime(optionsRef.current);
      runtimeRef.current = runtime;
      setState(copyState(runtime.state));
    }
    runtime.onChange = (next) => setState(copyState(next));
    void runtime.start();
    return () => runtime.destroy();
  }, []);

  const send = useCallback((text: string) => runtimeRef.current!.send(text), []);
  const abort = useCallback(() => runtimeRef.current!.abort(), []);
  const retry = useCallback(() => runtimeRef.current!.sync(), []);
  return { state, send, abort, retry, runtime: runtimeRef.current };
}
