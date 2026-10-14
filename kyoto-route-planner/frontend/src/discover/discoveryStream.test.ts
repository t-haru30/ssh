import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { waitFor } from "@testing-library/react";
import { readDiscovery } from "./discoveryStream";

afterEach(()=>vi.unstubAllGlobals());
beforeEach(async()=>{
  const native=await vi.importActual<{TextDecoder:typeof globalThis.TextDecoder;TextEncoder:typeof globalThis.TextEncoder}>("node:util");
  const web=await vi.importActual<{ReadableStream:typeof globalThis.ReadableStream}>("node:stream/web");
  vi.stubGlobal("TextDecoder",native.TextDecoder);vi.stubGlobal("TextEncoder",native.TextEncoder);vi.stubGlobal("ReadableStream",web.ReadableStream);
});
it("delivers the first deck immediately and decodes Japanese split across stream chunks",async()=>{
  let controller!:ReadableStreamDefaultController<Uint8Array>;
  const body=new ReadableStream<Uint8Array>({start(value){controller=value as unknown as typeof controller;}});
  const response={headers:{get:()=>"text/event-stream"},body} as unknown as Response;
  const receive=vi.fn(),pending=readDiscovery(response,receive),encode=new TextEncoder();
  const first=encode.encode('data: '+JSON.stringify({stage:"initial",result:{routes:[],note:"京都の旅"}})+'\r\n\r\n');
  for(const byte of first)controller.enqueue(new Uint8Array([byte]));
  await waitFor(()=>expect(receive).toHaveBeenCalledWith({routes:[],note:"京都の旅"},"initial"));
  controller.enqueue(encode.encode('data: '+JSON.stringify({stage:"complete",result:{routes:[],note:"最終案"}})+'\n\n'));
  controller.close();
  await pending;
  expect(receive).toHaveBeenLastCalledWith({routes:[],note:"最終案"},"complete");
});
it("keeps compatibility with a server returning one JSON response",async()=>{
  const receive=vi.fn();
  await readDiscovery({json:async()=>({routes:[],note:"既存API"})} as Response,receive);
  expect(receive).toHaveBeenCalledWith({routes:[],note:"既存API"},"complete");
});
it("reports an interrupted stream after delivering its usable initial deck",async()=>{
  const body=new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('data: {"stage":"initial","result":{"routes":[],"note":"候補"}}\n\n'));controller.close();}});
  const receive=vi.fn();
  await expect(readDiscovery({headers:{get:()=>"text/event-stream"},body} as unknown as Response,receive)).rejects.toThrow("interrupted");
  expect(receive).toHaveBeenCalledOnce();
});
