process.on('message',message=>{
  if(message?.type==='shutdown')process.exit(0);
  if(message?.type==='test_request')process.send?.({type:'engine_request',id:message.id,method:message.method,params:message.params});
  if(message?.type==='engine_reply')process.send?.({...message,type:'test_reply'});
});
