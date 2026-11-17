<?php
declare(strict_types=1);
require __DIR__.'/../php/worker.php';
$c=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);
try{
 if(($c['action']??'')==='memory-census'){
  $costs=[];foreach($c['cases'] as $text){$estimate=fleet_json_allocation_bytes($text);$before=memory_get_usage(false);$decoded=json_decode($text,false,512,JSON_THROW_ON_ERROR);$actual=memory_get_usage(false)-$before;unset($decoded);$costs[]=['estimate'=>$estimate,'actual'=>$actual];}
  $strings=[];foreach($c['strings'] as $text){$encoded=2;$tail='';for($i=0;$i<strlen($text);$i+=2){$part=substr($text,$i,2);$encoded+=fleet_json_string_bytes($part,$tail);$tail=substr($tail.$part,-2);}$strings[]=['estimated'=>$encoded,'actual'=>strlen(json_encode($text,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR))];}
  echo json_encode(['costs'=>$costs,'strings'=>$strings,'layout'=>fleet_json_layout()],JSON_THROW_ON_ERROR),"\n";exit(0);
 }
 if(($c['action']??'')==='stale-lock'){
  $stale=new FleetStore($c['state_directory']);$writer=new FleetStore($c['state_directory']);$writer->lock();$writer->data['outbox']['fresh-attempt']=['job_id'=>'fresh-job','body'=>['worker_id'=>'persisted-worker','result'=>['kept'=>true]]];$writer->data['checkpoints']['fresh-job']=['next'=>7];$writer->save();unset($writer);$stale->lock();$stale->save();echo json_encode(['state'=>$stale->data]),"\n";exit(0);
 }
 if(($c['action']??'')==='worker'){$worker=new FleetWorker($c);$worker->store->lock();$worked=$worker->tick();echo json_encode(['worked'=>$worked,'capabilities'=>$worker->capabilities,'state'=>$worker->store->data,'peak_memory_bytes'=>memory_get_peak_usage(true)],JSON_THROW_ON_ERROR),"\n";exit(0);}
 $store=new FleetStore($c['state_directory']);$store->lock();$client=new FleetClient($c);$transfer=new FleetTransfer($client,$store,$c);
 // The finite inline-view experiment starts its clock at the target phase.
 // Parallel test startup/source traffic must not consume that experiment first.
 $inlineStarted=null;$window=$c['inline_window_seconds']??0;
 $pulse=static function(array $progress=[])use(&$inlineStarted,$window):void{if($progress===[]&&$window>0){$inlineStarted??=microtime(true);if(microtime(true)-$inlineStarted>=$window)throw new FleetPending('actual_host_window_yield');}};
 $result=$transfer->execute($c['job'],$c['request'],$pulse);echo json_encode(['result'=>$result,'peak_memory_bytes'=>memory_get_peak_usage(true),'layout'=>fleet_json_layout()],JSON_THROW_ON_ERROR),"\n";
}catch(Throwable $e){echo json_encode(['error'=>get_class($e),'code'=>$e->getMessage(),'peak_memory_bytes'=>memory_get_peak_usage(true)],JSON_THROW_ON_ERROR),"\n";exit(1);}
