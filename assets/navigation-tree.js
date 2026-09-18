export const treePages = nodes => nodes.flatMap(node => 'page' in node ? [node.page] : treePages(node.children || []));
export function normalizeTree(tree, order) {
  const positions = new Map(order.map((page, i) => [page, i]));
  const normalize = nodes => nodes.flatMap(node => {
    if ('page' in node) return positions.has(node.page) ? [{ page: node.page }] : [];
    const children = normalize(node.children || []), ranks = treePages(children).map(page => positions.get(page));
    if (!ranks.length) return [];
    if (Math.max(...ranks) - Math.min(...ranks) + 1 !== ranks.length) return children;
    return [{ ...node, children }];
  }).sort((a, b) => positions.get(treePages([a])[0]) - positions.get(treePages([b])[0]));
  const included = new Set(treePages(tree));
  return normalize([...tree, ...order.filter(page => !included.has(page)).map(page => ({ page }))]);
}
export function moveInTree(tree, order, moving, target, after) {
  const copy = structuredClone(tree);
  const remove = nodes => { for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].page === moving) nodes.splice(i, 1);
    else if (nodes[i].children) remove(nodes[i].children);
  }};
  remove(copy);
  const insert = nodes => { for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].page === target) { nodes.splice(i + Number(after), 0, { page: moving }); return true; }
    if (nodes[i].children && insert(nodes[i].children)) return true;
  } return false; };
  if (!insert(copy)) copy.push({ page: moving });
  return normalizeTree(copy, order);
}
export function groupInTree(tree, order, pages, key, title) {
  const copy = structuredClone(tree), selected = new Set(pages);
  const paths = [];
  const walk = (nodes, path) => nodes.forEach(node => {
    if ('page' in node) { if (selected.has(node.page)) paths.push(path); }
    else walk(node.children || [], [...path, node]);
  });
  walk(copy, []);
  let parent;
  for (let i = 0; i < (paths[0]?.length || 0); i++) {
    if (paths.every(path => path[i] === paths[0][i])) parent = paths[0][i]; else break;
  }
  const remove = nodes => { for (let i = nodes.length - 1; i >= 0; i--) {
    if (selected.has(nodes[i].page)) nodes.splice(i, 1);
    else if (nodes[i].children) remove(nodes[i].children);
  }};
  remove(copy);
  (parent ? parent.children : copy).push({ key, title, open: true, children: order.filter(page => selected.has(page)).map(page => ({ page })) });
  return normalizeTree(copy, order);
}
/**
 * 把 moving 放到「某个父节点下的第 index 位」。parentKey 为 null 表示根级。
 * 与 moveInTree 不同，它可以表达「放进空章节 / 折叠章节末尾」这类没有相邻页作参照的位置。
 * index 是按「移走 moving 之后」父节点 children 计算的插入位。
 * 返回 { tree, order }，order 直接由新树推导，天然满足服务端 navigation_pages(tree) === order。
 */
export function moveToTreePosition(tree, moving, parentKey, index) {
  const copy = structuredClone(tree);
  const remove = nodes => { for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].page === moving) nodes.splice(i, 1);
    else if (nodes[i].children) remove(nodes[i].children);
  }};
  remove(copy);
  const findParent = nodes => { for (const node of nodes) {
    if (!node.children) continue;
    if (node.key === parentKey) return node.children;
    const hit = findParent(node.children); if (hit) return hit;
  } return null; };
  const target = parentKey == null ? copy : findParent(copy);
  if (!target) return null;
  const at = Math.max(0, Math.min(index, target.length));
  target.splice(at, 0, { page: moving });
  const order = treePages(copy);
  return { tree: normalizeTree(copy, order), order };
}
