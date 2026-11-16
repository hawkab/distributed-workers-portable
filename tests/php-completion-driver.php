<?php
declare(strict_types=1);
require_once __DIR__.'/../php/worker.php';
require_once __DIR__.'/../php/completion.php';
$config=json_decode(file_get_contents($argv[1]),true,512,JSON_THROW_ON_ERROR);$store=new FleetStore($config['state_directory']);$client=new FleetClient($config);$job=$config['job'];
try{$result=['text'=>str_repeat($config['pattern']??'Ж"\\', $config['repeat']??10000),'nested'=>['ok'=>true,'n'=>null]];$completion=$client->identity($job)+['status'=>'succeeded','result'=>$result,'artifact_ids'=>[]];$expected=hash('sha256',json_encode($result,JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR));$prepared=fleet_prepare_completion($client,$store,$job,$completion,$config,static function(array $progress=[]):void{});echo json_encode(['completion'=>$prepared,'expected_sha256'=>$expected,'peak_memory_bytes'=>memory_get_peak_usage(true)],JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR),"\n";}
catch(Throwable $error){echo json_encode(['code'=>$error->getMessage()]),"\n";exit(1);}
