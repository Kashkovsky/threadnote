export const packageExportPatterns = files =>
  [...new Set(files.map(file => (file.includes('/') ? `${file.slice(0, file.indexOf('/'))}/**` : file)))].sort();

export const packageOwner = (file, packageRoots) =>
  packageRoots.filter(root => file.startsWith(root + '/')).sort((left, right) => right.length - left.length)[0] ?? '';

export const bazelSourceLabel = (file, packageRoots) => {
  const owner = packageOwner(file, packageRoots);
  return `//${owner}:${owner ? file.slice(owner.length + 1) : file}`;
};
