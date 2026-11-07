"""The words in the confirm email and on the confirm and unsubscribe pages, in the site's languages.
A signup says which language the site was in; anything else gets English."""

from __future__ import annotations

LANGS = ("en", "ja", "ko", "zh-cn", "zh-tw")
HTML_LANG = {"en": "en", "ja": "ja", "ko": "ko", "zh-cn": "zh-Hans", "zh-tw": "zh-Hant"}

TEXTS: dict[str, dict[str, str]] = {
    "en": {
        "subject": "Confirm your email for Four Games news",
        "body": ("Hi!\n\nSomeone, hopefully you, asked to get an email from Four Games when we release a new game. "
                 "To say yes, open this link and press the button:\n\n{confirm}\n\n"
                 "If it wasn't you, just ignore this email. We'll delete the address in 7 days."),
        "footer": "Four Games, Sweden · fourgames.se\nUnsubscribe: {unsub}",
        "confirm_title": "Join the Four Games list?",
        "confirm_line": "Press the button to get an email when we release a new game.",
        "confirm_button": "Yes, add me",
        "confirmed_title": "You're on the list",
        "confirmed_line": "We'll email you when a new game comes out. Every email has a link to unsubscribe.",
        "bad_link_title": "This link doesn't work any more",
        "bad_link_line": "It's already been used, or it's older than 7 days. If you already confirmed, you're on the list. If not, sign up again at the bottom of fourgames.se.",
        "unsub_title": "Unsubscribe from Four Games news?",
        "unsub_line": "You won't get any more emails from us.",
        "unsub_button": "Unsubscribe",
        "unsubbed_title": "You're unsubscribed",
        "unsubbed_line": "We've deleted your email address. You won't get any more emails from us.",
        "error_title": "Something went wrong",
        "error_line": "Please try again in a little while.",
        "back": "Go to fourgames.se",
    },
    "ja": {
        "subject": "Four Games のお知らせメールの確認",
        "body": ("こんにちは。\n\nFour Games の新作が出たときにメールを受け取る登録がありました。"
                 "登録するには、このリンクを開いてボタンを押してください：\n\n{confirm}\n\n"
                 "心当たりがない場合は、このメールを無視してください。アドレスは7日後に削除されます。"),
        "footer": "Four Games（スウェーデン）· fourgames.se\n配信停止：{unsub}",
        "confirm_title": "Four Games のリストに登録しますか？",
        "confirm_line": "ボタンを押すと、新作が出たときにメールが届きます。",
        "confirm_button": "はい、登録します",
        "confirmed_title": "登録しました",
        "confirmed_line": "新作が出たらメールでお知らせします。すべてのメールに配信停止のリンクがあります。",
        "bad_link_title": "このリンクは使えなくなりました",
        "bad_link_line": "すでに使われたか、7日以上たっています。確認済みなら登録は完了しています。まだなら fourgames.se の一番下からもう一度登録してください。",
        "unsub_title": "Four Games のお知らせを停止しますか？",
        "unsub_line": "今後、私たちからメールは届きません。",
        "unsub_button": "配信を停止",
        "unsubbed_title": "配信を停止しました",
        "unsubbed_line": "メールアドレスを削除しました。今後、私たちからメールは届きません。",
        "error_title": "問題が発生しました",
        "error_line": "しばらくしてからもう一度お試しください。",
        "back": "fourgames.se へ",
    },
    "ko": {
        "subject": "Four Games 소식 이메일을 확인해 주세요",
        "body": ("안녕하세요!\n\nFour Games가 새 게임을 출시할 때 이메일을 받겠다는 신청이 있었습니다. "
                 "신청하려면 이 링크를 열고 버튼을 눌러 주세요:\n\n{confirm}\n\n"
                 "본인이 신청하지 않았다면 이 이메일을 무시하세요. 주소는 7일 후 삭제됩니다."),
        "footer": "Four Games (스웨덴) · fourgames.se\n수신 거부: {unsub}",
        "confirm_title": "Four Games 목록에 가입할까요?",
        "confirm_line": "버튼을 누르면 새 게임이 나올 때 이메일을 받습니다.",
        "confirm_button": "네, 가입할게요",
        "confirmed_title": "가입되었습니다",
        "confirmed_line": "새 게임이 나오면 이메일로 알려 드립니다. 모든 이메일에 수신 거부 링크가 있습니다.",
        "bad_link_title": "이 링크는 더 이상 사용할 수 없습니다",
        "bad_link_line": "이미 사용되었거나 7일이 지났습니다. 이미 확인했다면 가입되어 있습니다. 아니라면 fourgames.se 맨 아래에서 다시 가입해 주세요.",
        "unsub_title": "Four Games 소식 수신을 거부할까요?",
        "unsub_line": "더 이상 이메일을 받지 않게 됩니다.",
        "unsub_button": "수신 거부",
        "unsubbed_title": "수신 거부되었습니다",
        "unsubbed_line": "이메일 주소를 삭제했습니다. 더 이상 이메일을 받지 않습니다.",
        "error_title": "문제가 발생했습니다",
        "error_line": "잠시 후 다시 시도해 주세요.",
        "back": "fourgames.se로 이동",
    },
    "zh-cn": {
        "subject": "请确认你的 Four Games 新闻邮件",
        "body": ("你好！\n\n有人（希望是你）申请在 Four Games 发布新游戏时收到邮件。"
                 "如需确认，请打开此链接并点击按钮：\n\n{confirm}\n\n"
                 "如果不是你本人申请，请忽略此邮件。该地址将在 7 天后删除。"),
        "footer": "Four Games（瑞典）· fourgames.se\n退订：{unsub}",
        "confirm_title": "加入 Four Games 邮件列表？",
        "confirm_line": "点击按钮，在我们发布新游戏时收到邮件。",
        "confirm_button": "是的，加入",
        "confirmed_title": "你已加入列表",
        "confirmed_line": "新游戏发布时我们会给你发邮件。每封邮件都有退订链接。",
        "bad_link_title": "此链接已失效",
        "bad_link_line": "它已被使用过，或已超过 7 天。如果你已经确认过，你就在列表中。否则请在 fourgames.se 页面底部重新订阅。",
        "unsub_title": "退订 Four Games 新闻？",
        "unsub_line": "你将不会再收到我们的邮件。",
        "unsub_button": "退订",
        "unsubbed_title": "你已退订",
        "unsubbed_line": "我们已删除你的邮箱地址。你将不会再收到我们的邮件。",
        "error_title": "出了点问题",
        "error_line": "请稍后再试。",
        "back": "前往 fourgames.se",
    },
    "zh-tw": {
        "subject": "請確認你的 Four Games 新聞郵件",
        "body": ("你好！\n\n有人（希望是你）申請在 Four Games 推出新遊戲時收到郵件。"
                 "如需確認，請開啟此連結並按下按鈕：\n\n{confirm}\n\n"
                 "如果不是你本人申請，請忽略此郵件。該地址將在 7 天後刪除。"),
        "footer": "Four Games（瑞典）· fourgames.se\n取消訂閱：{unsub}",
        "confirm_title": "加入 Four Games 郵件清單？",
        "confirm_line": "按下按鈕，在我們推出新遊戲時收到郵件。",
        "confirm_button": "是的，加入",
        "confirmed_title": "你已加入清單",
        "confirmed_line": "新遊戲推出時我們會寄信給你。每封郵件都有取消訂閱的連結。",
        "bad_link_title": "此連結已失效",
        "bad_link_line": "它已被使用過，或已超過 7 天。如果你已經確認過，你就在清單中。否則請在 fourgames.se 頁面底部重新訂閱。",
        "unsub_title": "取消訂閱 Four Games 新聞？",
        "unsub_line": "你將不會再收到我們的郵件。",
        "unsub_button": "取消訂閱",
        "unsubbed_title": "你已取消訂閱",
        "unsubbed_line": "我們已刪除你的電子郵件地址。你將不會再收到我們的郵件。",
        "error_title": "發生錯誤",
        "error_line": "請稍後再試。",
        "back": "前往 fourgames.se",
    },
}


def lang_or_default(lang: str | None) -> str:
    lang = (lang or "").strip().lower()
    return lang if lang in TEXTS else "en"


def text(lang: str, key: str) -> str:
    return TEXTS[lang_or_default(lang)][key]


def site_url(lang: str) -> str:
    lang = lang_or_default(lang)
    return "https://fourgames.se/" if lang == "en" else f"https://fourgames.se/{lang}/"
