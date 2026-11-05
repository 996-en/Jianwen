/**
 * 微信公众号文章种子。
 *
 * 这些文章都来自“人民日报”公众号，发布时间覆盖 2017–2026 年。与短链种子
 * 不同，每条 URL 都自带一个公开索引里找到的 `chksm`，因此即使目标文章没有
 * 相邻文章、也没有被搜索引擎收录，也能直接拿来尝试打开目标长链。
 *
 * 一条 chksm 可能过期，所以保留 20 条；学习逻辑会把这些值全部作为候选，
 * 逐个尝试目标文章，成功后把可用的值落盘缓存。
 */
export interface WeixinSeedArticle {
  /** 维护用说明，不参与解析。 */
  label: string;
  /** 文章长链，URL 自带 chksm（也兼容以后改成短链）。 */
  url: string;
  /** 发布时间（YYYY-MM），只用于体现时间段覆盖。 */
  month: string;
}

export const WEIXIN_SEED_ARTICLES: readonly WeixinSeedArticle[] = [
  {
    label: "人民日报推 rap 动画",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666152123&idx=1&sn=c2de58076c5989fb9ca56ee1564ed58b&chksm=bdb229f88ac5a0eea30c87aece2ea363c06b92297ca1e7a8d25fba6bc943564aeb639e426cbe",
    month: "2017-03",
  },
  {
    label: "这个版本的《沙漠骆驼》",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666235701&idx=1&sn=c0777acb9cec909f4210643e1d06b92b&chksm=bdb3ee768ac46760518c430584363b77d5e498eda27a62b5b7fb90975a7f43dd913189ab16d2",
    month: "2019-01",
  },
  {
    label: "琉球故宫火灾",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666279229&idx=2&sn=116faf51b0e3bd2ec64eeedf7a5f3572&chksm=bdb4587e8ac3d168ef99f7fd2558dc4ed29176a1e094ccef0b3f0332b8410ba920199ee18ddf",
    month: "2019-10",
  },
  {
    label: "加油，热干面",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666293517&idx=2&sn=cef0ed4ee46092f7073633a2c7e137b6&chksm=bdb4004e8ac389580c7e5f88b8b9d78ce47518b88214e376bf878f41a292df72318b57528ef3",
    month: "2020-01",
  },
  {
    label: "这 10 个追问，美国必须回答",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666311715&idx=1&sn=35f1e9e0350a4358bd1a7df6657bb306&chksm=bdb4d9608ac35076fc3dfa04e646b124793cb4975a165f819fc71e121b290d19b9567bc417c3",
    month: "2020-04",
  },
  {
    label: "这 21 款 App 违法",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666312459&idx=2&sn=5f5963c927bda44e19c8958f4a6fca5e&chksm=bdb4da488ac3535ecf3a178b20e5a9cdd800a7fde37967290d6540e5175ea6929db13916e093",
    month: "2020-05",
  },
  {
    label: "庆祝共青团成立 100 周年讲话",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666522601&idx=1&sn=6856801d6dff1f88c8176cf723a8b53c&chksm=bdb78eaa8ac007bcf881b5785241ffc6306c0a354cad3ad64c421fb9565d7fc02d6f0d4a065d",
    month: "2022-05",
  },
  {
    label: "今日，开幕",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666594299&idx=1&sn=172dcef5928cc78c8bd081bc60de64a0&chksm=bda896b88adf1fae45b60a22f979f87beeea67041fe6fc503d815a8b093fd40dfb98ab862358",
    month: "2022-10",
  },
  {
    label: "浙大 313 寝室助学金",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666649091&idx=1&sn=68e3f0c7fa46e4a9e7839d02270d2803&chksm=bda9bf408ade3656bb1f5b3b0bf1a7ffc73ea78179ec82483ab396c7d2da4e072bce358890ab",
    month: "2023-03",
  },
  {
    label: "夜读·刷新自己",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666775142&idx=1&sn=d76a8e5fdb1961f297efb9ef969eb7ce&chksm=bdabab258adc22336d8824f476aee2d1fbf82653a528f71bb8dcdc43680b432b6b163e2f78f6",
    month: "2024-01",
  },
  {
    label: "夜读·一半书香，一半烟火",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666775586&idx=1&sn=b246803e5f2e19e0d77655ddd005b76e&chksm=bdabad618adc2477757f42f7ee3d2cb8c6288b858aa77f7f93e357d4a4883cd7eb9ed1ddba04",
    month: "2024-01",
  },
  {
    label: "易鹏飞，无期徒刑",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666805786&idx=1&sn=0b2eebaa648e05f3e7349e22c01833d5&chksm=bdac53598adbda4feff70c791a89693b5ae4a2e0ad0d03d3595bae0dd52466e403c954f56662",
    month: "2024-03",
  },
  {
    label: "政府工作报告",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666925619&idx=1&sn=d3724968ea400de5acd55a35ad98e692&chksm=bca010d38579fa15f5e1b6431d7ffc5fa8291fe143ca1ce9c7dd15bef753e7a5441b6b8ccf5f",
    month: "2025-03",
  },
  {
    label: "如果说一次阅兵一生光荣",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666966102&idx=1&sn=f65e0326b73f904faaf56b6e344008ba&chksm=bcd2a55d3c6ffdd19f3354d2c91cb9073ebcd6a24cd61449819a9acfaa28ebcdc1a64f0cd11d",
    month: "2025-08",
  },
  {
    label: "携程被约谈",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666970806&idx=1&sn=f15a20bdb4b59385384bf0b554b3981d&chksm=bc2df3041c3fb7e72352add8a52ea4753cad34ff9c9d16549e5f64b6c83ae27ab83c72af30d1",
    month: "2025-09",
  },
  {
    label: "体育老师当校长",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666983731&idx=1&sn=2b4fa716c1e7fbdc8351a066a8c2006e&chksm=bce59dd035beab6d05ba74f09a7ac8542937d9434a88514a8f647bf0552d7c1b6c141d1d633e",
    month: "2025-11",
  },
  {
    label: "不能放任酒店趁节狂涨价",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666998743&idx=1&sn=0937e45b54a0b324273b599cb026e394&chksm=bce7aa960c288cbf51e4b6caf9eca2904add8fde457edce281f7c5e7a1bd8d5cf79128e2981a",
    month: "2026-02",
  },
  {
    label: "蔡明谈春晚",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2666999106&idx=1&sn=a616d4a00130753904ed2e3a626ef58f&chksm=bce39942d4136dc439f8ba4b9b9915caa19fdf28d1f4bbe306578d18f80d4382b932b53c2a69",
    month: "2026-02",
  },
  {
    label: "25 年了，阿伟",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2667005405&idx=1&sn=b817a7d06b1afacb06d1a66bf662d48e&chksm=bc14f8f0566fc94f847e7ff1266e016cb47e89452f9437d02558d64ef2f021a358b7364bc7dd",
    month: "2026-03",
  },
  {
    label: "生锈的同心锁",
    url: "https://mp.weixin.qq.com/s?__biz=MjM5MjAxNDM4MA==&mid=2667025377&idx=1&sn=82e5cb456a25850a31bf2f6c622915a5&chksm=bcdc4e6447cb1512d72050067399a6e6d68728fa2fd5f70845fc69407c5a473e5460c20e78e1",
    month: "2026-08",
  },
];
