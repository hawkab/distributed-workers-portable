<?php
declare(strict_types=1);

// Lock before reading state or selecting an installed runtime. Keep this handle
// alive for the whole process; older runtimes need no lock-adoption API.
if (PHP_SAPI !== 'cli') { http_response_code(404); exit(2); }
if (PHP_VERSION_ID < 80200) { fwrite(STDERR, "php82_required\n"); exit(2); }
if ($argc < 2) {
    fwrite(STDERR, "Usage: php php/bootstrap.php PRIVATE_CONFIG.json [--once|--drain]\n");
    exit(2);
}
try {
    $config = json_decode(file_get_contents($argv[1]), true, 512, JSON_THROW_ON_ERROR);
    $stateDirectory = $config['state_directory'] ?? null;
    if (!is_string($stateDirectory) || $stateDirectory === '') { throw new RuntimeException('state_directory_required'); }
    if (!is_dir($stateDirectory) && !mkdir($stateDirectory, 0700, true) && !is_dir($stateDirectory)) { throw new RuntimeException('state_directory_failed'); }
    $processLock = fopen($stateDirectory . '/php-worker.lock', 'c+');
    if ($processLock === false) { throw new RuntimeException('worker_lock_open_failed'); }
    // A competing cron invocation leaves the active process and its state alone.
    if (!flock($processLock, LOCK_EX | LOCK_NB)) { exit(0); }

    $directory = __DIR__ . '/..';
    $rootVersion = json_decode(file_get_contents($directory . '/VERSION.json'), true, 512, JSON_THROW_ON_ERROR);
    $file = $stateDirectory . '/state.json';
    if (is_file($file)) {
        $saved = json_decode(file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
        $update = $saved['update'] ?? [];
        if (isset($update['current_code'])) {
            if (!is_int($update['current_code']) || $update['current_code'] < 1) { throw new RuntimeException('installed_version_pointer_invalid'); }
            // A newly provisioned authenticated bootstrap can be newer than the
            // previous installed runtime. Do not force that bootstrap backwards.
            if ($update['current_code'] >= $rootVersion['code']) {
                $installedDirectory = ($config['install_directory'] ?? $stateDirectory . '/runtime') . '/' . $update['current_code'];
                $installed = json_decode(file_get_contents($installedDirectory . '/.installed.json'), true, 512, JSON_THROW_ON_ERROR);
                if ($installed['sha256'] !== $update['sha256'] || $installed['version_code'] !== $update['current_code']) { throw new RuntimeException('installed_version_pointer_invalid'); }
                $directory = $installedDirectory;
            }
        }
    }
    require $directory . '/php/worker.php';
    require $directory . '/php/updater.php';
    $worker = new FleetWorker($config);
    $updater = new FleetUpdater($config, $worker->store, $directory);
    $once = in_array('--once', $argv, true);
    $drain = in_array('--drain', $argv, true);
    do {
        try {
            $busy = $worker->tick();
            if (time() >= ($worker->store->data['update_check_at'] ?? 0) + ($config['update_poll_seconds'] ?? 900)) {
                $worker->store->data['update_check_at'] = time();
                $worker->store->save();
                $update = $updater->check();
                if ($update['state'] === 'installed') { exit(75); }
            }
        } catch (FleetPending $e) {
            fwrite(STDERR, json_encode(['event' => 'worker_pending', 'code' => $e->getMessage()]) . "\n");
            if ($e->getMessage() === 'actual_host_window_yield') { exit(0); }
            // Finite cron runs leave transport uncertainty for durable recovery
            // on their next invocation, rather than spinning or claiming success.
            if ($once || $drain) { exit(1); }
            $busy = false;
        }
        if (!$busy && !$once && !$drain) { sleep($config['poll_seconds'] ?? 5); }
    } while (!$once && (!$drain || $busy));
} catch (Throwable $e) {
    $message = $e->getMessage();
    $code = preg_match('/^[a-z][a-z0-9_]*$/D', $message) ? $message : get_class($e);
    fwrite(STDERR, json_encode(['event' => 'worker_stopped', 'code' => $code]) . "\n");
    exit(1);
}
