<?php
declare(strict_types=1);
function fleet_cpu_list(?string $text):?int{if($text===null||trim($text)==='')return null;$ranges=[];foreach(explode(',',trim($text)) as $part){if(!preg_match('/^(\d+)(?:-(\d+))?$/D',$part,$m))return null;$a=(int)$m[1];$b=(int)($m[2]??$m[1]);if($b<$a)return null;$ranges[]=[$a,$b];}usort($ranges,static fn($a,$b)=>$a[0]<=>$b[0]);$total=0;$end=-1;foreach($ranges as [$a,$b]){$total+=max(0,$b-max($a,$end+1)+1);$end=max($end,$b);}return $total>0?$total:null;}
function fleet_cgroup_paths(string $base,string $relative):array{$all=[$base];$p=$base.rtrim($relative,'/');while($p!==$base&&str_starts_with($p,$base.'/')){$all[]=$p;$p=dirname($p);}return $all;}
function fleet_profile(array $capabilities,string $directory,array $deps=[]):array{
 $read=static function(string $p)use($deps):?string{try{$v=isset($deps['read'])?($deps['read'])($p):@file_get_contents($p);return is_string($v)?trim($v):null;}catch(Throwable){return null;}};
 $number=static function(string $p)use($read):?int{$v=$read($p);return $v!==null&&preg_match('/^\d+$/D',$v)?(int)$v:null;};
 $minimum=static function(...$values){$known=array_values(array_filter($values,static fn($v)=>$v!==null));return $known?min($known):null;};
 $resources=['cpu_logical_cores'=>null,'cpu_available_cores'=>null,'ram_total_bytes'=>null,'ram_available_bytes'=>null,'disk_total_bytes'=>null,'disk_available_bytes'=>null,'gpu_status'=>'unknown','gpus'=>[]];
 try{
  $logical=null;$available=null;$memory=null;$headroom=null;$physical=null;$free=null;
  $platform=$deps['platform']??PHP_OS_FAMILY;
  if(strcasecmp($platform,'Linux')===0){
   $cpu=$read('/proc/cpuinfo');if($cpu!==null){preg_match_all('/^processor\s*:/m',$cpu,$m);if(count($m[0])>0)$logical=count($m[0]);}
   $status=$read('/proc/self/status');if($status!==null&&preg_match('/^Cpus_allowed_list:\s*(.+)$/m',$status,$m))$available=fleet_cpu_list($m[1]);
   $mem=$read('/proc/meminfo');if($mem!==null){if(preg_match('/^MemTotal:\s*(\d+)\s+kB/m',$mem,$m))$physical=(int)$m[1]*1024;if(preg_match('/^MemAvailable:\s*(\d+)\s+kB/m',$mem,$m))$free=(int)$m[1]*1024;}
   $groups=$read('/proc/self/cgroup')??'';$root='/sys/fs/cgroup';$roots=[$root];
   if(preg_match('/^0::(\/.+)$/m',$groups,$m)&&!in_array('..',explode('/',$m[1]),true)){$p=$root.$m[1];while($p!==$root&&str_starts_with($p,$root.'/')){$roots[]=$p;$p=dirname($p);}}
   foreach(array_unique($roots) as $dir){$max=$read($dir.'/cpu.max');if($max!==null&&preg_match('/^(\d+)\s+(\d+)$/D',$max,$m)&&(float)$m[1]>0&&(float)$m[2]>0)$available=$minimum($available,(float)$m[1]/(float)$m[2]);$available=$minimum($available,fleet_cpu_list($read($dir.'/cpuset.cpus.effective')));$v=$number($dir.'/memory.max');if($v!==null){$memory=$minimum($memory,$v);$used=$number($dir.'/memory.current');if($used!==null)$headroom=$minimum($headroom,max(0,$v-$used));}}
   foreach(explode("\n",$groups) as $line){$parts=explode(':',$line);if(count($parts)!==3||!str_starts_with($parts[2],'/')||in_array('..',explode('/',$parts[2]),true))continue;foreach(explode(',',$parts[1]) as $controller){foreach(array_unique(array_merge(fleet_cgroup_paths($root.'/'.$controller,$parts[2]),fleet_cgroup_paths($root.'/'.$parts[1],$parts[2]))) as $dir){if($controller==='cpu'){$q=$read($dir.'/cpu.cfs_quota_us');$p=$read($dir.'/cpu.cfs_period_us');if(is_numeric($q)&&is_numeric($p)&&(float)$q>0&&(float)$p>0)$available=$minimum($available,(float)$q/(float)$p);}if($controller==='cpuset')$available=$minimum($available,fleet_cpu_list($read($dir.'/cpuset.cpus')));if($controller==='memory'){$v=$number($dir.'/memory.limit_in_bytes');if($v!==null&&$v<2**60){$memory=$minimum($memory,$v);$used=$number($dir.'/memory.usage_in_bytes');if($used!==null)$headroom=$minimum($headroom,max(0,$v-$used));}}}}}
   try{$cards=isset($deps['read_dir'])?($deps['read_dir'])('/sys/class/drm'):@scandir('/sys/class/drm');if(is_array($cards)){foreach($cards as $card){if(!preg_match('/^card\d+$/D',$card)||$read('/sys/class/drm/'.$card.'/device/vendor')===null)continue;$p='/sys/class/drm/'.$card.'/device';$t=$number($p.'/mem_info_vram_total');$u=$number($p.'/mem_info_vram_used');$resources['gpus'][]=['index'=>count($resources['gpus']),'compute_units'=>null,'memory_total_bytes'=>$t,'memory_available_bytes'=>$t!==null&&$u!==null?max(0,$t-$u):null,'unified_memory'=>null];}if($resources['gpus'])$resources['gpu_status']='detected';}}catch(Throwable){}
  }
  $usage=$deps['memory_usage']??memory_get_usage(true);$limit=$deps['memory_limit']??ini_get('memory_limit');$processLimit=null;
  if(is_string($limit)&&preg_match('/^\s*(\d+)\s*([KMG]?)\s*$/iD',$limit,$m)){$processLimit=(int)$m[1]*(1024**(array_search(strtoupper($m[2]),['','K','M','G'],true)));if($processLimit<=0)$processLimit=null;}
  if(($deps['include_process_limits']??true)===false)$processLimit=null;
  $resources['cpu_logical_cores']=$logical;$resources['cpu_available_cores']=$minimum($logical,$available);
  $resources['ram_total_bytes']=$minimum($physical,$memory,$processLimit);$resources['ram_available_bytes']=$minimum($resources['ram_total_bytes'],$free,$headroom,$processLimit!==null?max(0,$processLimit-$usage):null);
  foreach(['disk_total_bytes'=>'disk_total_space','disk_available_bytes'=>'disk_free_space'] as $key=>$function){try{$v=isset($deps[$function])?($deps[$function])($directory):@$function($directory);$resources[$key]=is_numeric($v)&&is_finite((float)$v)&&$v>=0?(int)$v:null;}catch(Throwable){}}
 }catch(Throwable){}
 return ['schema'=>1,'capabilities'=>array_values($capabilities),'resources'=>$resources];
}
function fleet_encode_profile(array $profile):string{return rtrim(strtr(base64_encode(json_encode($profile,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR)),'+/','-_'),'=');}

// Optional system discovery cannot disable ordinary HTTP or compute work.
function fleet_abi():array{try{if(!function_exists('php_uname'))return [];$arch=php_uname('m');return is_string($arch)&&$arch!==''?[$arch]:[];}catch(Throwable){return [];}}
function fleet_memory_limit_bytes():?int{try{$limit=ini_get('memory_limit');if(!is_string($limit)||!preg_match('/^\s*(\d+)\s*([KMG]?)\s*$/iD',$limit,$m))return null;$bytes=(int)$m[1]*(1024**array_search(strtoupper($m[2]),['','K','M','G'],true));return is_int($bytes)&&$bytes>0?$bytes:null;}catch(Throwable){return null;}}
function fleet_memory_fits(int $additional):bool{$limit=fleet_memory_limit_bytes();return $limit===null||$additional>=0&&$additional<=max(0,$limit-memory_get_usage(true));}
// Exact UTF-8 JSON string byte growth, including separators split across chunks.
function fleet_json_string_bytes(string $part,string $priorTail=''):int{return strlen($part)+5*preg_match_all('/[\x00-\x1f]/',$part)-4*preg_match_all('/[\x08\x09\x0a\x0c\x0d]/',$part)+substr_count($part,'"')+substr_count($part,'\\')+3*(substr_count($priorTail.$part,"\xe2\x80\xa8")+substr_count($priorTail.$part,"\xe2\x80\xa9"));}
function fleet_json_layout():array{
 static $layout=null;if($layout!==null)return $layout;
 $arrayCost=static function(int $n):int{$before=memory_get_usage(false);$v=array_fill(0,$n,null);return memory_get_usage(false)-$before;};
 $objectCost=static function(int $n):int{$before=memory_get_usage(false);$v=new stdClass();for($i=0;$i<$n;$i++)$v->{'k'.$i}=null;return memory_get_usage(false)-$before;};
 $before=memory_get_usage(false);$v=str_repeat('x',128);$stringBase=max(0,memory_get_usage(false)-$before-128);unset($v);
 $a=[];$o=[];foreach([8,16,32,64,128,256,512,1024,2048] as $capacity){$a[$capacity]=$arrayCost($capacity);$o[$capacity]=$objectCost($capacity)-$capacity*$stringBase;}
 // Small allocator classes have discontinuities. Keep their measured costs;
 // only extrapolate the stable large-table slot growth beyond those classes.
 $arraySlot=max(1,intdiv($a[2048]-$a[1024],1024),intdiv($a[1024]-$a[512],512));
 $mapSlot=max(1,intdiv($o[2048]-$o[1024],1024),intdiv($o[1024]-$o[512],512));
 return $layout=['arrays'=>$a,'objects'=>$o,'array_slot'=>$arraySlot,'map_slot'=>$mapSlot,'array_base'=>max(0,$a[2048]-2048*$arraySlot),'object_base'=>max(0,$o[2048]-2048*$mapSlot),'string_base'=>$stringBase,'empty_object'=>$objectCost(0)];
}
// Budget the actual runtime's decoded container layout before json_decode can
// fatally exhaust memory. This scans shape only; PHP remains the syntax decoder.
function fleet_json_allocation_bytes(string $text,?callable $pulse=null):?int{
 $layout=fleet_json_layout();$stack=[];$cost=0;$length=strlen($text);$nextPulse=0;
 $capacity=static function(int $n):int{$size=8;while($size<$n)$size*=2;return $size;};
 $value=static function()use(&$stack):void{$last=count($stack)-1;if($last>=0&&$stack[$last]['type']==='[')$stack[$last]['count']++;};
 for($i=0;$i<$length;$i++){if($pulse!==null&&$i>=$nextPulse){$pulse();$nextPulse=$i+8192;}$c=$text[$i];if(str_contains(" \r\n\t,",$c))continue;
  if($c==='['||$c==='{'){$value();if(count($stack)>=511)return null;$stack[]=['type'=>$c,'count'=>0];continue;}
  if($c===']'||$c==='}'){$frame=array_pop($stack);if($frame===null)return null;$n=$frame['count'];$cap=$capacity($n);$cost+=$frame['type']==='['?($n===0?0:($layout['arrays'][$cap]??$layout['array_base']+$cap*$layout['array_slot'])):($n===0?$layout['empty_object']:($layout['objects'][$cap]??$layout['object_base']+$cap*$layout['map_slot']));continue;}
  if($c===':'){$last=count($stack)-1;if($last<0||$stack[$last]['type']!=='{')return null;$stack[$last]['count']++;continue;}
  if($c==='"'){$value();$start=++$i;for(;$i<$length;$i++){if($pulse!==null&&$i>=$nextPulse){$pulse();$nextPulse=$i+8192;}if($text[$i]==='\\'){$i++;continue;}if($text[$i]==='"')break;}if($i>=$length)return null;$bytes=$i-$start;if($bytes>0)$cost+=$layout['string_base']+8*(int)ceil($bytes/8);continue;}
  $value();for(;$i+1<$length&&!str_contains(" \r\n\t,]}",$text[$i+1]);$i++);
 }
 return $stack?null:$cost;
}
