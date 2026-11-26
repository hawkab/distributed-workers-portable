<?php
declare(strict_types=1);
require_once __DIR__.'/concurrency.php';
function fleet_pool(array $config,string $directory,bool $drain=false,$rootLock=null,$admission=null):void{
 if(!function_exists('proc_open'))throw new RuntimeException('parallel_process_runtime_unavailable');
 $root=$config['state_directory'];$lock=fopen($root.'/pool.lock','c+');if(!$lock||!flock($lock,LOCK_EX|LOCK_NB))return;
 if(function_exists('proc_nice')){@proc_nice(10);}
 $admission??=new FleetAdmission($config,$root);$children=[];$stopping=false;$updating=false;$nextUpdate=0;$stopFile=getenv('WORKER_STOP_FILE')?:'';
 if(function_exists('pcntl_async_signals')){pcntl_async_signals(true);foreach([SIGINT,SIGTERM]as$sig)pcntl_signal($sig,static function()use(&$stopping):void{$stopping=true;});}
 $save=static function(string $file,array $data):void{$temp=$file.'.'.bin2hex(random_bytes(8));file_put_contents($temp,json_encode($data,JSON_THROW_ON_ERROR));chmod($temp,0600);rename($temp,$file);};
 $scheduler=$root.'/scheduler.json';$lastBusy=true;$lastSample=0;$execution=['max_concurrent_jobs'=>1,'mode'=>'shared'];
 try{while(true){
  clearstatcache();if(is_file($root.'/runtime-stop')||is_file($root.'/maintenance')||($stopFile!==''&&is_file($stopFile)))$stopping=true;
  foreach($children as$id=>$child){$status=proc_get_status($child['process']);if($status['running'])continue;$output=stream_get_contents($child['stdout']);fclose($child['stdout']);$code=$status['exitcode'];proc_close($child['process']);unset($children[$id]);if(str_contains($output,'"busy":true'))$lastBusy=true;elseif($drain&&$code===0)$stopping=true;}
  if(microtime(true)-$lastSample>=2){$lastSample=microtime(true);$execution=$admission->sample(count($children));}
  if(time()>=$nextUpdate)$updating=true;
  $advertised=$execution;if($stopping||$updating||is_file($root.'/admission-drain'))$advertised['max_concurrent_jobs']=0;$save($scheduler,['execution'=>$advertised]);
  if(($stopping||$updating)&&!$children){
   if($stopping)break;
   require_once $directory.'/php/worker.php';require_once $directory.'/php/updater.php';$store=new FleetStore($root);$updater=new FleetUpdater($config,$store,$directory);$result=$updater->check();$nextUpdate=time()+($config['update_poll_seconds']??900);$updating=false;if(($result['state']??'')==='installed')exit(75);continue;
  }
  if(!$stopping&&!$updating&&!is_file($root.'/admission-drain')){
   // Recover retained slots before starting new work, including slots above a reduced budget.
   $ids=range(0,max(0,$execution['max_concurrent_jobs']-1));if($execution['max_concurrent_jobs']===0)$ids=[];
   foreach(glob($root.'/slots/*/state.json')?:[]as$file){try{$state=json_decode(file_get_contents($file),true,512,JSON_THROW_ON_ERROR);if(!empty($state['active'])||!empty($state['outbox']))$ids[]=(int)basename(dirname($file));}catch(Throwable){throw new RuntimeException('slot_state_invalid');}}
   foreach(array_unique($ids)as$id){if(isset($children[$id]))continue;$state=$id===0?$root:$root.'/slots/'.$id;if(!is_dir($state))mkdir($state,0700,true);$childConfig=$config;$childConfig['state_directory']=$state;$childConfig['slot_id']=$id;$childConfig['scheduler_file']=$scheduler;$childConfig['managed_slot']=true;$childConfig['root_lock_inherited']=$id===0;$childConfig['claim_wait_seconds']=20;$file=$state.'/slot.local.json';$save($file,$childConfig);$pipes=[];$descriptors=[0=>['file',PHP_OS_FAMILY==='Windows'?'NUL':'/dev/null','r'],1=>['pipe','w'],2=>STDERR];if($id===0){if(!is_resource($rootLock))throw new RuntimeException('root_lock_required');$descriptors[3]=$rootLock;}$process=proc_open([PHP_BINARY,$directory.'/php/bootstrap.php',$file,'--once'],$descriptors,$pipes,null,null,['bypass_shell'=>true]);if(!is_resource($process))throw new RuntimeException('slot_start_failed');stream_set_blocking($pipes[1],false);$children[$id]=['process'=>$process,'stdout'=>$pipes[1]];}
  }
  usleep(100000);
 }}finally{fclose($lock);}
}
