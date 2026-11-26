<?php
declare(strict_types=1);
require_once __DIR__.'/hardware.php';
// The same admission equations as the Node adapter. Jobs are never time-limited.
function fleet_budget(array $x):array{
 $mode=$x['mode']??'shared';$target=$mode==='batch'?.8:($mode==='router'?.25:.5);$reserve=(int)ceil(($x['total']??0)*($mode==='batch'?.15:.25));$previous=$x['previous']??1;$cpu=$x['cpu']??null;
 $out=['slots'=>min(1,$previous),'mode'=>$mode,'cpu_utilization'=>$cpu,'memory_reserve_bytes'=>$reserve];
 if(isset($x['available'],$x['total'])&&$x['available']<=$reserve){$out['slots']=0;return $out;}
 if(!isset($x['cores'],$x['available'],$x['total'])||$x['cores']<=0||$x['total']<=0||$cpu===null)return $out;
 $active=$x['active']??0;$perJob=$x['memory_per_job']??134217728;$memory=min($active+(int)floor(($x['available']-$reserve)/$perJob),(int)floor(($x['total']-$reserve)/$perJob));$cost=$x['cpu_per_job']??1;$physical=max(1,(int)floor($x['cores']/$cost));$slots=$active+(int)floor(($target-$cpu)*$x['cores']/$cost);if($cpu>$target)$slots=$active-(int)ceil(($cpu-$target)*$x['cores']/$cost);if($active===0&&$cpu<$target)$slots=max(1,$slots);$out['slots']=max(0,min($memory,$physical,$slots,$previous+1));return $out;
}
final class FleetAdmission{
 private ?array $last=null;private int $previous=1;public array $execution=['max_concurrent_jobs'=>1,'mode'=>'shared'];
 public function __construct(private array $config,private string $directory){$c=$config['concurrency']??[];foreach(['memory_per_job_bytes','cpu_per_job_cores']as$key)if(isset($c[$key])&&(!is_numeric($c[$key])||$c[$key]<=0))throw new RuntimeException('invalid_concurrency_reservation');}
 public function sample(int $active):array{
  $cpu=null;$stat=@file_get_contents('/proc/stat');$now=microtime(true);$sample=null;
  if(is_string($stat)&&preg_match('/^cpu\s+(.+)$/m',$stat,$m)){$v=array_map('intval',preg_split('/\s+/',trim($m[1])));$sample=['total'=>array_sum(array_slice($v,0,8)),'idle'=>($v[3]??0)+($v[4]??0),'at'=>$now];if($this->last&&$sample['total']>$this->last['total'])$cpu=max(0,min(1,1-($sample['idle']-$this->last['idle'])/($sample['total']-$this->last['total'])));}
  try{$q=@file_get_contents('/sys/fs/cgroup/cpu.max');$s=@file_get_contents('/sys/fs/cgroup/cpu.stat');if(is_string($q)&&preg_match('/^(\d+)\s+(\d+)/',$q,$m)&&is_string($s)&&preg_match('/^usage_usec (\d+)/m',$s,$u)){$sample??=['total'=>0,'idle'=>0,'at'=>$now];$sample['usage']=(float)$u[1];if(isset($this->last['usage'])&&$cpu!==null&&$now>$this->last['at'])$cpu=max($cpu,min(1,($sample['usage']-$this->last['usage'])/1e6/($now-$this->last['at'])/((float)$m[1]/(float)$m[2])));}}catch(Throwable){}
  $this->last=$sample;$r=fleet_profile([],$this->directory,['include_process_limits'=>false])['resources'];$c=$this->config['concurrency']??[];$b=fleet_budget(['cores'=>$r['cpu_available_cores'],'available'=>$r['ram_available_bytes'],'total'=>$r['ram_total_bytes'],'cpu'=>$cpu,'active'=>$active,'previous'=>$this->previous,'mode'=>$c['mode']??'shared','memory_per_job'=>$c['memory_per_job_bytes']??134217728,'cpu_per_job'=>$c['cpu_per_job_cores']??1]);$this->previous=$b['slots'];$this->execution=['max_concurrent_jobs'=>$b['slots'],'mode'=>$b['mode'],'cpu_utilization'=>$b['cpu_utilization'],'memory_reserve_bytes'=>$b['memory_reserve_bytes']];return $this->execution;
 }
}
function fleet_scheduler_profile(array $profile,array $config):array{
 $file=$config['scheduler_file']??null;if(!is_string($file))return $profile;
 try{$s=json_decode(file_get_contents($file),true,512,JSON_THROW_ON_ERROR);if(!isset($s['execution']['max_concurrent_jobs'])||!is_int($s['execution']['max_concurrent_jobs']))throw new RuntimeException('invalid_scheduler');$profile['execution']=$s['execution'];}catch(Throwable){$profile['execution']=['max_concurrent_jobs'=>0,'mode'=>'scheduler_unavailable'];}
 return $profile;
}
