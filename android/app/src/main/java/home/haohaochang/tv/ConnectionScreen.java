package home.haohaochang.tv;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.List;

/** Native UI remains visible even if the TV browser cannot start. */
final class ConnectionScreen extends LinearLayout {
    interface Actions { void scan(); void manual(); void connect(String address); void cancel(); void update(); }
    private final Activity activity;
    private final Actions actions;
    private final LinearLayout card;
    private final int ink=Color.rgb(245,241,255), muted=Color.rgb(182,172,199), accent=Color.rgb(208,185,255);
    ConnectionScreen(Activity activity,Actions actions,String heading,String description) {
        super(activity);this.activity=activity;this.actions=actions;
        boolean compact=getResources().getConfiguration().screenWidthDp<700;
        setOrientation(VERTICAL);setPadding(dp(compact?20:32),dp(20),dp(compact?20:32),dp(20));
        setBackground(new GradientDrawable(GradientDrawable.Orientation.TL_BR,new int[]{Color.rgb(29,23,42),Color.rgb(13,12,20)}));
        addView(text("好好唱  /  HOME KARAOKE",16,accent,true));
        LinearLayout body=new LinearLayout(activity);body.setGravity(Gravity.CENTER_VERTICAL);if(compact)body.setOrientation(VERTICAL);
        LayoutParams bodyParams=new LayoutParams(-1,0,1);bodyParams.topMargin=dp(18);bodyParams.bottomMargin=dp(18);addView(body,bodyParams);
        LinearLayout hero=new LinearLayout(activity);hero.setOrientation(VERTICAL);hero.setPadding(0,0,compact?0:dp(32),0);body.addView(hero,compact?new LayoutParams(-1,-2):new LayoutParams(0,-2,1));
        hero.addView(text(compact?"好好唱，随时开唱。":"把客厅，\n变成你的主场。",compact?27:36,ink,true));
        TextView subtitle=text(compact?"连接家庭歌房，在手机上点歌和播放。":"电视负责大画面，手机负责点歌。\n连上家庭歌房，就能扫码开唱。",compact?14:17,muted,false);subtitle.setPadding(0,dp(compact?8:18),0,dp(compact?16:26));hero.addView(subtitle);
        if(!compact)hero.addView(text("01  找到歌房    →    02  手机扫码    →    03  开唱",12,accent,false));
        ScrollView scroll=new ScrollView(activity);scroll.setFillViewport(false);body.addView(scroll,compact?new LayoutParams(-1,0,1):new LayoutParams(0,-1,1.15f));
        card=new LinearLayout(activity);card.setOrientation(VERTICAL);card.setPadding(dp(26),dp(24),dp(26),dp(24));card.setBackground(surface(Color.rgb(35,29,47),Color.rgb(67,55,85)));scroll.addView(card,new ScrollView.LayoutParams(-1,-2));
        card.addView(text(heading,25,ink,true));TextView summary=text(description,16,muted,false);summary.setPadding(0,dp(12),0,dp(16));card.addView(summary);
        addView(text(compact?"请与 NAS 连接同一个家庭网络":"手机与电视连接同一个家庭网络  ·  遥控器菜单键可打开设置",12,muted,false));
    }
    void searching(String address) {
        TextView pulse=text("●  正在寻找局域网歌房…",18,accent,true);pulse.setPadding(0,dp(12),0,dp(20));card.addView(pulse);
        button("手动输入地址",actions::manual,false).requestFocus();if(!address.isEmpty())button("返回原歌房",actions::cancel,false);
    }
    void loading(String address) {card.addView(text(address,15,accent,false));button("更换服务器",actions::manual,false).requestFocus();}
    void manual(String current,boolean canCancel) {
        card.addView(text("NAS 地址",14,ink,true));
        EditText input=new EditText(activity);input.setSingleLine(true);input.setTextColor(ink);input.setHintTextColor(muted);input.setTextSize(16);input.setPadding(dp(14),dp(8),dp(14),dp(8));input.setBackground(surface(Color.rgb(21,18,30),Color.rgb(93,77,115)));
        input.setInputType(android.text.InputType.TYPE_CLASS_TEXT|android.text.InputType.TYPE_TEXT_VARIATION_URI);input.setHint("http://192.168.1.10:43210");input.setText(current);
        LayoutParams field=new LayoutParams(-1,dp(52));field.topMargin=dp(8);field.bottomMargin=dp(8);card.addView(input,field);
        Runnable connect=()->{try{actions.connect(ConnectionPolicy.normalize(input.getText().toString()));}catch(IllegalArgumentException error){input.setError(error.getMessage());input.requestFocus();}};
        input.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_GO);input.setOnEditorActionListener((v,id,event)->{if(id==android.view.inputmethod.EditorInfo.IME_ACTION_GO){connect.run();return true;}return false;});
        button("连接歌房",connect,true).requestFocus();button("重新自动发现",actions::scan,false);if(canCancel)button("返回原歌房",actions::cancel,false);
        button("检查更新",actions::update,false);
    }
    void servers(List<LanDiscovery.Server> servers) {for(LanDiscovery.Server server:servers)button("家庭歌房\n"+server.address,()->actions.connect(server.address),true);button("手动输入其他地址",actions::manual,false);card.getChildAt(2).requestFocus();}
    void failure(String address,String detail) {
        if(!detail.isEmpty()){TextView info=text(detail,13,muted,false);info.setPadding(0,0,0,dp(8));card.addView(info);}
        if(!address.isEmpty())button("重新连接",()->actions.connect(address),true).requestFocus();button("自动寻找歌房",actions::scan,false);Button manual=button("手动输入地址",actions::manual,false);if(address.isEmpty())manual.requestFocus();
    }
    private Button button(String caption,Runnable click,boolean primary) {
        Button button=new Button(activity);button.setText(caption);button.setAllCaps(false);button.setTextSize(16);button.setGravity(Gravity.CENTER);button.setMinHeight(dp(46));button.setPadding(dp(12),dp(8),dp(12),dp(8));
        int bg=primary?accent:Color.rgb(46,38,61);button.setTextColor(primary?Color.rgb(32,19,48):ink);button.setBackground(surface(bg,primary?accent:Color.rgb(77,63,96)));
        button.setOnFocusChangeListener((view,focused)->button.setBackground(surface(bg,focused?Color.WHITE:primary?accent:Color.rgb(77,63,96),focused?3:1)));button.setOnClickListener(v->click.run());
        LayoutParams params=new LayoutParams(-1,-2);params.topMargin=dp(12);card.addView(button,params);return button;
    }
    private TextView text(String value,int size,int color,boolean bold){TextView view=new TextView(activity);view.setText(value);view.setTextSize(size);view.setTextColor(color);view.setLineSpacing(dp(3),1);if(bold)view.setTypeface(Typeface.DEFAULT,Typeface.BOLD);return view;}
    private GradientDrawable surface(int color,int stroke){return surface(color,stroke,1);}
    private GradientDrawable surface(int color,int stroke,int width){GradientDrawable shape=new GradientDrawable();shape.setColor(color);shape.setCornerRadius(dp(18));shape.setStroke(dp(width),stroke);return shape;}
    private int dp(int value){return Math.round(value*getResources().getDisplayMetrics().density);}
}
