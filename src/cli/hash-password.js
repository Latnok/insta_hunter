import { hash } from 'bcryptjs';
import { stdin, stdout } from 'node:process';

function readHiddenPassword(prompt) {
  if (!stdin.isTTY || typeof stdin.setRawMode !== 'function') throw new Error('An interactive TTY is required');
  stdout.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (key) => {
      if (key === '\u0003') {
        stdin.setRawMode(false); stdin.pause(); reject(new Error('Cancelled'));
      } else if (key === '\r' || key === '\n') {
        stdin.off('data', onData); stdin.setRawMode(false); stdin.pause(); stdout.write('\n'); resolve(value);
      } else if (key === '\u007f' || key === '\b') {
        if (value.length) { value = value.slice(0, -1); stdout.write('\b \b'); }
      } else if (key >= ' ') {
        value += key; stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

const password = await readHiddenPassword('Password: ');
if (!password || password.length < 10) {
  throw new Error('Password must contain at least 10 characters');
}
console.log(await hash(password, 12));
