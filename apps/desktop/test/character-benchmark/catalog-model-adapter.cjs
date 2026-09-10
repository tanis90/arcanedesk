// Catalog benchmark adapter. Keeps setup/verification identical to the reviewed
// character suite; only the model-facing discovery instructions change.
const baseFactory=require('./model-adapter.cjs');
module.exports=(evaluate,options={})=>{
  const base=baseFactory(evaluate,options);
  return {...base,
    async setup(id,label){
      const p=require('./cases.cjs').cases.find(x=>x.id===id);
      return evaluate(`({newName:${JSON.stringify(label+' 霜牙')},name:${JSON.stringify(label+' 霜牙')},sourceBefore:null,beforeActorIds:game.actors.map(a=>a.id)})`);
    },
    prompt(id,label){
      return base.prompt(id,label)+
        ' 内容发现优先使用 foundry_content_search、foundry_content_list、foundry_content_detail；先读取来源上下文，再执行写入。不要把候选列表当成已选择结果。';
    }
  };
};
