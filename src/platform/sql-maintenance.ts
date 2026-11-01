let restoring=false;
export function assertSqlWritable():void {if(restoring)throw new Error("正在恢复存档，请等待重新打开");}
export async function restoreWithFence<T>(restore:()=>Promise<T>):Promise<T> {
  assertSqlWritable();restoring=true;
  try{return await restore();}catch(error){restoring=false;throw error;}
}
