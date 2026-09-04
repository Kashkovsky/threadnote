import {TestError} from './test-error.js';
import {provideTestLayer} from './effect-layer.js';
import {Clock, Effect, FileSystem, Path} from 'effect';
import {ApplicationLayer} from '../../src/effect/runtime.js';
import {withSharedRepositoryHomeLock} from '../../src/effect/share_lock.js';

const [home, readyPath, releasePath, remote, worktree] = process.argv.slice(2);
if (!home || !readyPath || !releasePath || !remote || !worktree) {
  throw TestError.make({message: 'Expected home, ready path, release path, remote, and worktree arguments.'});
}

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* withSharedRepositoryHomeLock(
      home,
      Effect.gen(function* () {
        const receiptPath = path.join(home, 'share', 'fetch-receipts', 'default.json');
        yield* fs.makeDirectory(path.dirname(receiptPath), {recursive: true});
        yield* fs.writeFileString(
          receiptPath,
          `${JSON.stringify({
            behind: 1,
            checkedAt: yield* Clock.currentTimeMillis,
            remote,
            succeeded: true,
            team: 'default',
            version: 1,
            worktree,
          })}\n`,
          {mode: 0o600},
        );
        yield* fs.writeFileString(readyPath, 'ready\n', {mode: 0o600});
        while (!(yield* fs.exists(releasePath))) {
          yield* Effect.sleep(10);
        }
      }),
    );
  }).pipe(provideTestLayer(ApplicationLayer)),
);
