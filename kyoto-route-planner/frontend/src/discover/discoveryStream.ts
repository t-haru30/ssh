import { isDiscoverResponse, type DiscoverResponse } from "./dynamicRoutes";

export async function readDiscovery(response: Response, receive: (data: DiscoverResponse, stage: "initial" | "complete") => void) {
  if (!response.headers?.get("content-type")?.includes("text/event-stream")) {
    const data: unknown = await response.json();
    if (!isDiscoverResponse(data)) throw new Error("Invalid discovery response");
    receive(data, "complete");
    return;
  }
  const reader=response.body?.getReader();
  if (!reader) throw new Error("Missing discovery stream");
  const decoder=new TextDecoder();
  let pending="", completed=false;
  function dispatch(block:string){
    const content=block.split("\n").filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trimStart()).join("\n");
    if (!content) return;
    const event: unknown=JSON.parse(content);
    if (!event || typeof event!=="object" || !("stage" in event) || !("result" in event)
      || !["initial","complete"].includes(String(event.stage)) || !isDiscoverResponse(event.result)) throw new Error("Invalid discovery event");
    const stage=event.stage as "initial"|"complete";
    receive(event.result,stage);
    if(stage==="complete")completed=true;
  }
  try {
    while(true){
      const {value,done}=await reader.read();
      pending+=done ? decoder.decode() : decoder.decode(value,{stream:true});
      pending=pending.replace(/\r\n/g,"\n");
      if(pending.length>2_000_000)throw new Error("Discovery event too large");
      let boundary:number;
      while((boundary=pending.indexOf("\n\n"))>=0){dispatch(pending.slice(0,boundary));pending=pending.slice(boundary+2);}
      if(done)break;
    }
    if(!completed)throw new Error("Discovery stream interrupted");
  } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
}
