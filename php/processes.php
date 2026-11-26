<?php
declare(strict_types=1);
function fleet_process_limits(?array $dependencies=null):array{
 $d=$dependencies??[];$platform=$d['platform']??PHP_OS_FAMILY;if($platform!=='Linux')return [];
 $read=$d['read']??static function(string $p):?string{$s=@file_get_contents($p);return $s===false?null:trim($s);};$list=$d['list']??static fn(string $p)=>@scandir($p);$stat=$d['stat']??static fn(string $p)=>@stat($p);$self=$stat('/proc/self');$uid=$d['uid']??(function_exists('posix_geteuid')?posix_geteuid():($self['uid']??null));$number=static function(string $p)use($read):?int{$s=$read($p);return is_string($s)&&preg_match('/^\d+$/D',trim($s))?(int)$s:null;};$limits=[];$dirs=['/sys/fs/cgroup'=>true];
 foreach(explode("\n",$read('/proc/self/cgroup')??'')as$line){$parts=explode(':',$line);if(count($parts)!==3||!str_starts_with($parts[2],'/')||in_array('..',explode('/',$parts[2]),true))continue;$bases=$parts[0]==='0'?['/sys/fs/cgroup']:(in_array('pids',explode(',',$parts[1]),true)?['/sys/fs/cgroup/pids']:[]);foreach($bases as$base){$p=$base.rtrim($parts[2],'/');$dirs[$base]=true;while($p!==$base&&str_starts_with($p,$base.'/')){$dirs[$p]=true;$p=dirname($p);}}}
 foreach(array_keys($dirs)as$dir){$max=$number($dir.'/pids.max');if($max!==null)$limits[]=['max'=>$max,'used'=>$number($dir.'/pids.current')];}
 if($uid!==null&&$uid!==0&&preg_match('/^Max processes\s+(\d+)\s+/m',$read('/proc/self/limits')??'',$m)){$used=0;$known=true;$entries=$list('/proc');if(!is_array($entries)){$known=false;$entries=[];}foreach($entries as$id){if(!ctype_digit((string)$id))continue;$s=$stat('/proc/'.$id);if(!is_array($s))continue;if(($s['uid']??null)!==$uid)continue;$v=$read('/proc/'.$id.'/status');if(!is_string($v)||!preg_match('/^Threads:\s+(\d+)/m',$v,$n)){$known=false;continue;}$used+=(int)$n[1];}$limits[]=['max'=>(int)$m[1],'used'=>$known?$used:null];}
 return $limits;
}
function fleet_process_budget(int $slots,int $active,array $limits,int $perJob=16,float $reserveFraction=.25):int{
 foreach($limits as$x){if($x['used']===null){$slots=min($slots,1);continue;}$reserve=(int)ceil($x['max']*$reserveFraction);$absolute=max(0,(int)floor(($x['max']-$reserve)/$perJob));$headroom=$active+(int)floor(($x['max']-$x['used']-$reserve)/$perJob);$slots=max(0,min($slots,$absolute,$headroom));}return $slots;
}
