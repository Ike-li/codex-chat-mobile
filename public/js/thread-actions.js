// 会话行上的动作里,只有「会拿走东西」的那两个需要拦一道确认。
//
// archive 此前是静默执行的:点完会话立刻从列表消失,而列表默认只拉未归档,
// 于是用户看到的就是「会话没了」,和删除毫无区别。它其实可逆,但这份可逆
// 必须先有「显示已归档」入口才成立——所以文案指名那个入口,而不是空口说「可恢复」。
export function threadActionConfirm(action) {
  if (action === 'archive') {
    return {
      title: '归档会话',
      body: '归档后会话会从列表移出。打开抽屉里的「显示已归档」可以找回并取消归档。',
      danger: false,
    };
  }
  if (action === 'delete') {
    return {
      title: '删除会话',
      body: '该会话将从 Codex 历史中移除,且无法从本页撤销。',
      danger: true,
    };
  }
  // unarchive 是把会话加回来,rename 走 prompt 自带输入确认,都不该再拦一道。
  return null;
}
